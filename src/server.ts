'use strict';

import {SolcCompiler} from './solcCompiler';
import Linter from './linter/linter';
import SolhintService from './linter/solhint';
import SoliumService from './linter/solium';
import {throttle} from './util';
import {CompletionService, GetCompletionTypes,
        GetContextualAutoCompleteByGlobalVariable, GeCompletionUnits,
        GetGlobalFunctions, GetGlobalVariables} from './completionService';

import {
    createConnection, IConnection,
    IPCMessageReader, IPCMessageWriter,
    TextDocuments, InitializeResult,
    Files, DiagnosticSeverity, Diagnostic,
    TextDocumentChangeEvent, TextDocumentPositionParams,
    CompletionItem, CompletionItemKind,
    Range, Position, Location, SignatureHelp,
} from 'vscode-languageserver';

interface Settings {
    solidity: SoliditySettings;
}

interface SoliditySettings {
    linter: boolean | string;
    enabledAsYouTypeCompilationErrorCheck: boolean;
    compileUsingLocalVersion: string;
    compileUsingRemoteVersion: string;
    linterDefaultRules: any;
    validationDelay: number;
}

// import * as path from 'path';
// Create a connection for the server
const connection: IConnection = createConnection(
    new IPCMessageReader(process),
    new IPCMessageWriter(process));

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

const documents: TextDocuments = new TextDocuments();

let rootPath: string;
let solcCompiler: SolcCompiler;
let linter: Linter = null;
let lastCompileErrorsForDocument = {};

let enabledAsYouTypeErrorCheck = false;
let compileUsingRemoteVersion = '';
let compileUsingLocalVersion = '';
let linterOption: boolean | string = false;
let linterDefaultRules = {};
let validationDelay = 1500;

// flags to avoid trigger concurrent validations (compiling is slow)
let validatingDocument = false;
let validatingAllDocuments = false;

connection.onSignatureHelp((textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
    return null;
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items
    let completionItems = [];
    try {
        let document = documents.get(textDocumentPosition.textDocument.uri);
        const documentPath = Files.uriToFilePath(textDocumentPosition.textDocument.uri);
        const documentText = document.getText();
        let lines = documentText.split(/\r?\n/g);
        let position = textDocumentPosition.position;

        let start = 0;
        let triggeredByDot = false;
        for (let i = position.character; i >= 0; i--) {
            if (lines[position.line[i]] === ' ') {
                triggeredByDot = false;
                i = 0;
                start = 0;
            }
            if (lines[position.line][i] === '.') {
                start = i;
                i = 0;
                triggeredByDot = true;
            }
        }

        if (triggeredByDot) {
            let globalVariableContext = GetContextualAutoCompleteByGlobalVariable(lines[position.line], start);
            if (globalVariableContext != null) {
                completionItems = completionItems.concat(globalVariableContext);
            }
            return completionItems;
        }

        const service = new CompletionService(rootPath);
        completionItems = completionItems.concat(service.getAllCompletionItems(documentText, documentPath));

    } catch (error) {
        // graceful catch
       // console.log(error);
    } finally {

        completionItems = completionItems.concat(GetCompletionTypes());
        completionItems = completionItems.concat(GeCompletionUnits());
        completionItems = completionItems.concat(GetGlobalFunctions());
        completionItems = completionItems.concat(GetGlobalVariables());
    }
    return completionItems;
});

documents.onDidChangeContent(event => {
    const document = event.document;

    if (!validatingDocument && !validatingAllDocuments) {
        validatingDocument = true; // control the flag at a higher level
        // slow down, give enough time to type (1.5 seconds?)
        setTimeout(() =>  validateCompilation(document), validationDelay);
    }

    lintAndSendDiagnostics(document);
});

// remove diagnostics from the Problems panel when we close the file
documents.onDidClose(event => connection.sendDiagnostics({
    diagnostics: [],
    uri: event.document.uri,
}));

documents.listen(connection);

connection.onInitialize((result): InitializeResult => {
    rootPath = result.rootPath;
    solcCompiler = new SolcCompiler(rootPath);

    if (linter === null) {
        linter = new SolhintService(rootPath, null);
    }

    return {
        capabilities: {
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: [ '.' ],
            },
            textDocumentSync: documents.syncKind,
        },
    };
});

connection.onDidChangeConfiguration((change) => {
    let settings = <Settings>change.settings;
    enabledAsYouTypeErrorCheck = settings.solidity.enabledAsYouTypeCompilationErrorCheck;
    linterOption = settings.solidity.linter;
    compileUsingLocalVersion = settings.solidity.compileUsingLocalVersion;
    compileUsingRemoteVersion = settings.solidity.compileUsingRemoteVersion;
    linterDefaultRules = settings.solidity.linterDefaultRules;
    validationDelay = settings.solidity.validationDelay;

    switch (linterOption) {
        case 'solhint': {
            linter = new SolhintService(rootPath, linterDefaultRules);
            break;
        }
        case 'solium': {
            linter = new SoliumService(linterDefaultRules, connection);
            break;
        }
        default: {
            linter = null;
        }
    }

    if (linter !== null) {
        linter.setIdeRules(linterDefaultRules);
    }

    startValidation();
});

connection.listen();

function validateAllDocuments() {
    if (!validatingAllDocuments) {
        validatingAllDocuments = true;

        const compileResults = documents
            .all()
            .map(document => validateCompilation(document));

        Promise
            .all(compileResults)
            .then(validateAllFlagToFalse, validateAllFlagToFalse);
    }
}

function startValidation() {
    if (enabledAsYouTypeErrorCheck) {
        solcCompiler
            .intialiseCompiler(compileUsingLocalVersion, compileUsingRemoteVersion)
            .then(() => validateAllDocuments());
    } else {
        validateAllDocuments();
    }
}

function validateCompilation(document): Promise<boolean> {
    if (enabledAsYouTypeErrorCheck) {
        validatingDocument = true;

        return compileFile(document)
            .then(storeCompileErrors.bind(this, document))
            .then(appendLinterErrors(document))
            .then(errors => sendDiagnostics(document.uri, ...errors))
            .then(validateFlagToFalse, validateFlagToFalse);
    } else {
        return Promise.resolve(false);
    }
}

const lintAndSendDiagnostics = throttle(100, document => 
    sendDiagnostics(document.uri, lintFile(document), lastCompileErrorsOf(document))
);

function lintFile(document) {
    if (!linter) {
        return [];
    }

    return linter.validate(fileOf(document), document.getText());
}

function compileFile(document) {
    const filePath = fileOf(document);
    const code = document.getText();

    return solcCompiler
        .compileSolidityDocumentAndGetDiagnosticErrors(filePath, code);
}

function sendDiagnostics(uri, ...diagnosticsList) {
    const diagnostics = mergeErrors(...diagnosticsList);
    connection.sendDiagnostics({ diagnostics, uri });
}

function fileOf(document) {
    return Files.uriToFilePath(document.uri);
}

function mergeErrors(...errors): Diagnostic[] {
    return errors
        .filter(i => i && i.length > 0)
        .reduce((prev, curErrors) => prev.concat(curErrors), []);
}

function lastCompileErrorsOf(document): Diagnostic[] {
    return lastCompileErrorsForDocument[fileOf(document)] || [];
}

function storeCompileErrors(document, errors) {
    const filePath = fileOf(document);
    return lastCompileErrorsForDocument[filePath] = errors;
}

const validateFlagToFalse = () => 
    validatingDocument = false;

const validateAllFlagToFalse = () => 
    validatingAllDocuments = false;

const appendLinterErrors = document => errors => 
    [errors, lintFile(document)];
