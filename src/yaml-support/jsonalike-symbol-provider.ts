import * as vscode from 'vscode';
import * as yp from 'yaml-ast-parser';
import * as _ from 'lodash';

export class JsonALikeYamlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
        return this.provideDocumentSymbolsImpl(document, token);
    }

    async provideDocumentSymbolsImpl(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        const fakeText = document.getText().replace(/{{[^}]*}}/g, (s) => encodeWithTemplateMarkers(s));
        const root = yp.safeLoad(fakeText);
        const syms: vscode.SymbolInformation[] = [];
        walk(root, '', document, document.uri, syms);
        return syms;
    }
}

// These MUST be the same lengths as the strings they replace
// ('{{', '}}' and '"'") - we rely on the text ranges staying
// the same in order to detect and substitute back the actual
// template expression.
const ENCODE_TEMPLATE_START = 'AA';
const ENCODE_TEMPLATE_END = 'ZZ';
const ENCODE_TEMPLATE_QUOTE = 'Q';

// This is pretty horrible, but the YAML parser can't handle embedded Go template
// expressions.  So we transform Go template expressions to (reasonably) distinctive
// strings with the EXACT SAME position and length, run the YAML parser, then when we
// construct the Helm AST, if we see such a string we check back to the original YAML
// document to fix it up if necessary.
function encodeWithTemplateMarkers(s: string): string {
    return s.replace(/{{/g, ENCODE_TEMPLATE_START)
            .replace(/}}/g, ENCODE_TEMPLATE_END)
            .replace(/"/g, ENCODE_TEMPLATE_QUOTE);
}

export interface FoundKeyPath {
    readonly found: vscode.SymbolInformation | undefined;
    readonly remaining: string[];
}

export function findKeyPath(keyPath: string[], sis: vscode.SymbolInformation[]): FoundKeyPath {
    return findKeyPathAcc(keyPath, sis, undefined);
}

function findKeyPathAcc(keyPath: string[], sis: vscode.SymbolInformation[], acc: vscode.SymbolInformation | undefined): FoundKeyPath {
    const parentSym = findKey(keyPath[0], sis);
    if (!parentSym) {
        return { found: acc, remaining: keyPath };
    }
    if (keyPath.length === 1) {
        return { found: parentSym, remaining: [] };
    }
    const childSyms = sis.filter((s) => parentSym.location.range.contains(s.location.range));
    return findKeyPathAcc(keyPath.slice(1), childSyms, parentSym);
}

function findKey(key: string, sis: vscode.SymbolInformation[]): vscode.SymbolInformation | undefined {
    const fields = sis.filter((si) => si.kind === vscode.SymbolKind.Field && si.name === key);
    if (fields.length === 0) {
        return undefined;
    }
    return outermost(fields);
}

function outermost(sis: vscode.SymbolInformation[]): vscode.SymbolInformation {
    return _.maxBy(sis, (s) => containmentChain(s, sis));
}

export function containmentChain(s: vscode.SymbolInformation, sis: vscode.SymbolInformation[]): vscode.SymbolInformation[] {
    const containers = sis.filter((si) => si.kind === vscode.SymbolKind.Field)
                          .filter((si) => si.location.range.contains(s.location.range))
                          .filter((si) => si !== s);
    if (containers.length === 0) {
        return [];
    }
    const nextUp = minimalSymbol(containers);
    const fromThere = containmentChain(nextUp, sis);
    return [nextUp, ...fromThere];
}

export function symbolAt(position: vscode.Position, sis: vscode.SymbolInformation[]): vscode.SymbolInformation | undefined {
    const containers = sis.filter((si) => si.location.range.contains(position));
    if (containers.length === 0) {
        return undefined;
    }
    return minimalSymbol(containers);
}

function minimalSymbol(sis: vscode.SymbolInformation[]): vscode.SymbolInformation {
    let m = sis[0];
    for (const si of sis) {
        if (m.location.range.contains(si.location.range)) {
            m = si;
        }
    }
    return m;
}

function symbolInfo(node: yp.YAMLNode, containerName: string, d: vscode.TextDocument, uri: vscode.Uri): vscode.SymbolInformation[] {
    const start = node.startPosition;
    const end = node.endPosition;
    const loc = new vscode.Location(uri, new vscode.Range(d.positionAt(start), d.positionAt(end)));
    switch (node.kind) {
        case yp.Kind.ANCHOR_REF:
            return [];
        case yp.Kind.INCLUDE_REF:
            return [];
        case yp.Kind.MAP:
            return [];
        case yp.Kind.MAPPING:
            const mp = node as yp.YAMLMapping;
            let sk = vscode.SymbolKind.String;
            switch (mp.value.kind) {
                case yp.Kind.MAP: sk = vscode.SymbolKind.Module; break;  // go figure
                case yp.Kind.MAPPING: sk = vscode.SymbolKind.Object; break;
                case yp.Kind.SEQ: sk = vscode.SymbolKind.Array; break;
            }
            return [new vscode.SymbolInformation(`${mp.key.rawValue}`, sk, containerName, loc)];
        case yp.Kind.SCALAR:
            return [];
        case yp.Kind.SEQ:
            return [];
    }
    return [];
}

function walk(node: yp.YAMLNode, containerName: string, d: vscode.TextDocument, uri: vscode.Uri, syms: vscode.SymbolInformation[]) {
    const sym = symbolInfo(node, containerName, d, uri);
    syms.push(...sym);
    switch (node.kind) {
        case yp.Kind.ANCHOR_REF:
            return;
        case yp.Kind.INCLUDE_REF:
            return;
        case yp.Kind.MAP:
            const m = node as yp.YamlMap;
            for (const mm of m.mappings) {
                walk(mm, containerName, d, uri, syms);
            }
            return;
        case yp.Kind.MAPPING:
            const mp = node as yp.YAMLMapping;
            if (mp.value) {
                walk(mp.value, `${containerName}${containerName ? '.' : ''}${sym[0].name}`, d, uri, syms);
            }
            return;
        case yp.Kind.SCALAR:
            return;
        case yp.Kind.SEQ:
            const s = node as yp.YAMLSequence;
            for (const y of s.items) {
                walk(y, containerName, d, uri, syms);
            }
            return;
    }
}
