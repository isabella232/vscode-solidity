'use strict';

import {SolcCompiler} from './solcCompiler';
import Linter from './linter/linter';
import SolhintService from './linter/solhint';
import SoliumService from './linter/solium';
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
    // option for backward compatibilities, please use "linter" option instead
    enabledSolium: boolean; 
    linter: boolean | string;
    enabledAsYouTypeCompilationErrorCheck: boolean;
    compileUsingLocalVersion: string;
    compileUsingRemoteVersion: string;
    // option for backward compatibilities, please use "linterDefaultRules" option instead
    soliumRules: any; 
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

let enabledAsYouTypeErrorCheck = false;
let compileUsingRemoteVersion = '';
let compileUsingLocalVersion = '';
let linterOption: boolean | string = false;
let linterDefaultRules = {};
let validationDelay = 1500;

// flags to avoid trigger concurrent validations (compiling is slow)
let validatingDocument = false;
let validatingAllDocuments = false;

function validate(document) {
    try {
        validatingDocument = true;
        const filePath = Files.uriToFilePath(document.uri);
        const documentText = document.getText();
        let linterDiagnostics: Diagnostic[] = [];
        let compileErrorDiagnostics: Diagnostic[] = [];

        if (linter !== null) {
            linterDiagnostics = linter.validate(filePath, documentText);
            sendDiagnostics(linterDiagnostics, document.uri);
        }

        if (enabledAsYouTypeErrorCheck) {
            compileErrorDiagnostics = solcCompiler
                .compileSolidityDocumentAndGetDiagnosticErrors(filePath, documentText);
        }

        const diagnostics = linterDiagnostics.concat(compileErrorDiagnostics);
        sendDiagnostics(diagnostics, document.uri);
    } finally {
        validatingDocument = false;
    }
}

function sendDiagnostics(diagnostics, uri) {
    connection.sendDiagnostics({ diagnostics, uri });
}

connection.onSignatureHelp((textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
    return null;
});

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




// This handler resolve additional information for the item selected in
// the completion list.
 // connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
 //   item.
 // });
function validateAllDocuments() {
    if (!validatingAllDocuments) {
        try {
            validatingAllDocuments = true;
            documents.all().forEach(document => validate(document));
        } finally {
            validatingAllDocuments = false;
        }
    }
}

function startValidation() {
    if (enabledAsYouTypeErrorCheck) {
        solcCompiler.intialiseCompiler(compileUsingLocalVersion, compileUsingRemoteVersion).then(() => {
            validateAllDocuments();
        });
    } else {
        validateAllDocuments();
    }
}

documents.onDidChangeContent(event => {
    const document = event.document;

    if (!validatingDocument && !validatingAllDocuments) {
        validatingDocument = true; // control the flag at a higher level
        // slow down, give enough time to type (1.5 seconds?)
        setTimeout(() =>  validate(document), validationDelay);
    }
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

    switch (linterName(settings.solidity)) {
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
        linter.setIdeRules(linterRules(settings.solidity));
    }

    startValidation();
});

function linterName(settings: SoliditySettings) {
    const linter = settings.linter;
    const enabledSolium = settings.enabledSolium;

    if (enabledSolium) {
        return 'solium';
    } else {
        return linter;
    }
}

function linterRules(settings: SoliditySettings) {
    const linterDefaultRules = settings.linterDefaultRules;
    const soliumRules = settings.soliumRules;
    const _linterName = linterName(settings);

    if (_linterName === 'solium') {
        return soliumRules || linterDefaultRules;
    } else {
        return linterDefaultRules;
    }
}

connection.listen();
