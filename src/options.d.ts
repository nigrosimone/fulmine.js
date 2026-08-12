/*
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// The option bags the file-serving and body-parsing paths take, written once and referenced from
// the JSDoc of the functions that read them. They live in a declaration file rather than as
// @typedef blocks in the sources because those sources export classes, and a typedef hanging off
// a `module.exports = class` module makes TypeScript see two unrelated copies of the class.

/** What res.sendFile, express.static and res.download all read. The names and defaults are send's. */
export interface SendFileOptions {
    /** The directory a relative path resolves against, and the boundary nothing may climb out of. */
    root?: string;
    /** Cache-Control's max-age, in milliseconds or as a duration such as "1d". */
    maxAge?: number | string;
    /** Adds Cache-Control: immutable, which is only meaningful next to a long maxAge. */
    immutable?: boolean;
    /** Whether Last-Modified is sent, from the file's mtime. */
    lastModified?: boolean;
    /** Whether an ETag is sent. */
    etag?: boolean;
    /** Whether a Range request is honoured. */
    acceptRanges?: boolean;
    /** Whether Cache-Control is sent at all. */
    cacheControl?: boolean;
    /**
     * What to do with a path holding a dotfile. "ignore_files" is one more than send offers:
     * it hides a dotfile that is the last segment while letting a dotted directory through.
     */
    dotfiles?: "allow" | "deny" | "ignore" | "ignore_files";
    /** Extra headers for the response. */
    headers?: Record<string, string>;
    /** Called before the file goes out, to set headers from the path or its stat. */
    setHeaders?: (res: any, path: string, stat: any) => void;
    /** First byte of the window to send. */
    start?: number;
    /** Last byte of the window to send. */
    end?: number;
    /** The path is already encoded, so leave it alone. */
    skipEncodePath?: boolean;
    /** Internal: locals carried through to a view render. */
    _locals?: Record<string, any>;
    /** Internal: the stat the caller already took, so it is not taken twice. */
    _stat?: any;
    /** Internal: the caller computed the ETag itself. */
    _ownEtag?: boolean;
}

/** What express.static reads on top of everything res.sendFile takes. */
export interface StaticOptions extends SendFileOptions {
    /** The file served for a directory, or false to serve none. */
    index?: string | false;
    /** Whether a directory without a trailing slash is redirected to one. */
    redirect?: boolean;
    /** Whether a request this middleware cannot serve moves on instead of being answered. */
    fallthrough?: boolean;
    /** Extensions tried when the path names no file, or false to try none. */
    extensions?: string[] | false;
    /**
     * Serve `file.br` or `file.gz` in place of `file` when one is on disk and the client takes it.
     * Off by default. Vary: Accept-Encoding is sent whether or not a variant is found, and the
     * content type stays the one the requested name implies.
     *
     * Which twins a path has is remembered for a second, since asking the disk costs a stat per
     * request; `{ cache: false }` asks every time, and a duration sets how long. Only their
     * presence is cached, never their size or mtime.
     */
    preCompressed?: boolean | { cache?: number | string | false };
}

/** A body parser's options once its factory has filled in every default it needs. */
export interface SettledBodyParserOptions extends BodyParserOptions {
    limit: number;
    inflate: boolean;
    /** the string form is turned into a one-element list by the factory */
    type: string[] | ((req: any) => boolean);
    defaultCharset: string;
}

/** What the body parsers take. The four share these; each names below the ones it alone reads. */
export interface BodyParserOptions {
    /** The largest body to accept, as bytes or as "100kb". */
    limit?: number | string;
    /** Which content types this parser claims. */
    type?: string | string[] | ((req: any) => boolean);
    /** Runs on the raw bytes before parsing, which is where a signature check belongs. */
    verify?: false | ((req: any, res: any, buf: Buffer, encoding: string) => void);
    /** Whether a compressed body is decompressed rather than refused. */
    inflate?: boolean;
    /** The charset assumed when the request names none. */
    defaultCharset?: string;
    /** json only: refuse a body that is not an object or an array. */
    strict?: boolean;
    /** json only, passed to JSON.parse. */
    reviver?: (key: string, value: any) => any;
    /** urlencoded only: parse with qs rather than the plain parser. */
    extended?: boolean;
    /** urlencoded only: how many parameters to accept. */
    parameterLimit?: number;
    /** urlencoded only, extended only: how deep a nested object may go. */
    depth?: number;
    /** urlencoded only, passed to qs. */
    charsetSentinel?: boolean;
    /** urlencoded only, passed to qs. */
    interpretNumericEntities?: boolean;
    /** Internal: the single type this parser claims, which lets the prologue compare strings. */
    simpleType?: string;
}
