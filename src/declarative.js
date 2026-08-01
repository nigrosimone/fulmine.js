const acorn = require("acorn");
const { stringify } = require("./utils.js");
// H3App, DeclarativeResponse and _cfg all exist at runtime but are missing from the
// declaration file the package ships, so the module is read through a loose alias
const uWS = require("uWebSockets.js");
const uWSAny = /** @type {any} */ (uWS);
const statuses = require("statuses");

const parser = acorn.Parser;

const allowedResMethods = ["set", "header", "setHeader", "sendStatus", "status", "send", "end", "append"];
const allowedIdentifiers = ["query", "params", ...allowedResMethods];
const objKeyRegex = /[\s{\n]([A-Za-z-0-9_]+)(\s|\n)*?:/g;

function replaceSingleCharacter(str, index, char) {
    return str.slice(0, index) + char + str.slice(index + 1);
}

// generates a declarative response from a callback
// uWS allows creating such responses and they are extremely fast
// since you don't even have to call into Node.js at all
// declarative response will only be created if callback is 'simple enough'
// simple enough means:
// - doesnt call external functions
// - doesnt create variables
// - only uses req.query and req.params
// basically, its only simple, static responses
module.exports = function compileDeclarative(cb, app) {
    try {
        let code = cb.toString();
        // convert anonymous functions to named ones to make it valid code
        if (code.startsWith("function") || code.startsWith("async function")) {
            code = code.replace(/function *\(/, "function __cb(");
        }

        // Everything below runs inside the try above, and any shape this does not understand falls
        // out as `return false`, which is the fallback to ordinary routing. That is the design, and
        // it is why the tree is walked loosely: acorn types every shape JavaScript can take, and
        // enumerating them here would be a second, worse copy of that catch.
        /** @type {any[]} */
        const tokens = [...acorn.tokenizer(code, { ecmaVersion: "latest" })];

        if (
            tokens.some((token) =>
                [
                    "throw",
                    "new",
                    "await",
                    "return",
                    "try",
                    "catch",
                    "finally",
                    "if",
                    "else",
                    "switch",
                    "case",
                    "default",
                    "for",
                    "while",
                    "do",
                    "var",
                    "let",
                    "const"
                ].includes(token.value)
            )
        ) {
            return false;
        }

        /** @type {any[]} */
        const parsed = parser.parse(code, { ecmaVersion: "latest" }).body;
        let fn = parsed[0];

        if (fn.type === "ExpressionStatement") {
            fn = fn.expression;
        }

        // check if it is a function
        if (fn.type !== "FunctionDeclaration" && fn.type !== "ArrowFunctionExpression") {
            return false;
        }

        const args = fn.params.map((param) => param.name);

        if (args.length < 2) {
            // invalid function? doesn't have (req, res) args
            return false;
        }

        const [req, res] = args;
        let queryName,
            paramsName,
            queries = [],
            params = [];

        if (fn.params[0].type === "ObjectPattern") {
            const query = fn.params[0].properties.find((prop) => prop.key.name === "query");
            const param = fn.params[0].properties.find((prop) => prop.key.name === "params");

            if (query?.value?.type === "Identifier") {
                queryName = query.value.name;
            } else if (query?.value?.type === "ObjectPattern") {
                for (const prop of query.value.properties) {
                    if (prop.value.type !== "Identifier") {
                        return false;
                    }
                    queries.push(prop.value.name);
                }
            } else {
                return false;
            }

            if (param?.value?.type === "Identifier") {
                paramsName = param.value.name;
            } else if (param?.value?.type === "ObjectPattern") {
                for (const prop of param.value.properties) {
                    if (prop.value.type !== "Identifier") {
                        return false;
                    }
                    params.push(prop.value.name);
                }
            } else {
                return false;
            }
        }

        // check if it calls any other function other than the one in `res`
        const callExprs = filterNodes(fn, (node) => node.type === "CallExpression");
        const resCalls = [];
        for (const expr of callExprs) {
            let calleeName, propertyName;

            // get propertyName
            if (expr.type === "MemberExpression") {
                propertyName = expr.property.name;
            } else if (expr.type === "CallExpression") {
                propertyName = expr.callee?.property?.name ?? expr.callee?.name;
            }

            // get calleeName
            switch (expr.callee.type) {
                case "Identifier":
                    calleeName = expr.callee.name;
                    break;
                case "MemberExpression":
                    if (expr.callee.object.type === "Identifier") {
                        calleeName = expr.callee.object.name;
                    } else if (expr.callee.object.type === "CallExpression") {
                        // function call chaining
                        let callee = expr.callee;
                        while (callee.object.callee) {
                            callee = callee.object.callee;
                        }
                        if (callee.object.type !== "Identifier") {
                            return false;
                        }
                        calleeName = callee.object.name;
                    }
                    break;
                default:
                    return false;
            }
            // check if calleeName is res
            if (calleeName !== res) {
                return false;
            }

            const obj = { calleeName, propertyName };
            expr.obj = obj;
            resCalls.push(obj);
        }

        // check if res property being called are
        // - set, header, setHeader
        // - status
        // - send
        // - end
        for (const call of resCalls) {
            if (!allowedResMethods.includes(call.propertyName)) {
                return false;
            }
        }

        // check if all identifiers are allowed
        const identifiers = filterNodes(fn, (node) => node.type === "Identifier")
            .slice(args.length)
            .map((id) => id.name);
        if (identifiers[identifiers.length - 1] === "__cb") {
            identifiers.pop();
        }
        if (
            !identifiers.every(
                (id, i) =>
                    allowedIdentifiers.includes(id) ||
                    id === req ||
                    id === res ||
                    (identifiers[i - 2] === req && identifiers[i - 1] === "params") ||
                    (identifiers[i - 2] === req && identifiers[i - 1] === "query") ||
                    id === queryName ||
                    id === paramsName ||
                    queries.includes(id) ||
                    params.includes(id)
            )
        ) {
            return false;
        }

        let statusCode = 200;
        // sendStatus and a bare send() both leave the body empty, and they mean different things:
        // one sends the status message, the other sends nothing
        let sendStatusUsed = false;
        const headers = [];
        const body = [];

        // get statusCode
        for (const call of callExprs) {
            if (call.obj.propertyName === "status") {
                if (call.arguments[0].type !== "Literal") {
                    return false;
                }
                statusCode = call.arguments[0].value;
            }
        }

        // get headers
        for (const call of callExprs) {
            if (
                call.obj.propertyName === "header" ||
                call.obj.propertyName === "setHeader" ||
                call.obj.propertyName === "set"
            ) {
                if (call.arguments[0].type !== "Literal" || call.arguments[1].type !== "Literal") {
                    return false;
                }
                const sameHeader = headers.find(
                    (header) => header[0].toLowerCase() === call.arguments[0].value.toLowerCase()
                );
                let [header, value] = [call.arguments[0].value, call.arguments[1].value];
                if (call.obj.propertyName !== "setHeader") {
                    if (value.includes("text/") && !value.includes("; charset=")) {
                        value += "; charset=utf-8";
                    }
                }
                if (sameHeader) {
                    sameHeader[1] = value;
                } else {
                    headers.push([header, value]);
                }
            } else if (call.obj.propertyName === "append") {
                if (call.arguments[0].type !== "Literal" || call.arguments[1].type !== "Literal") {
                    return false;
                }
                headers.push([call.arguments[0].value, call.arguments[1].value]);
            } else if (call.obj.propertyName === "sendStatus") {
                if (call.arguments[0].type !== "Literal") {
                    return false;
                }
                statusCode = call.arguments[0].value;
                sendStatusUsed = true;
            }
        }

        // get body
        let sendUsed = false;
        for (const call of callExprs) {
            if (call.obj.propertyName === "send" || call.obj.propertyName === "end") {
                if (sendUsed) {
                    return false;
                }
                if (call.obj.propertyName === "send") {
                    const index = headers.findIndex((header) => header[0].toLowerCase() === "content-type");
                    if (index === -1) {
                        headers.push(["content-type", "text/html; charset=utf-8"]);
                    } else {
                        if (headers[index][1].includes("text/") && !headers[index][1].includes("; charset=")) {
                            headers[index][1] += "; charset=utf-8";
                        }
                    }
                }
                const arg = call.arguments[0];
                if (arg) {
                    if (arg.type === "Literal") {
                        if (typeof arg.value === "number") {
                            // status code
                            return false;
                        }
                        let val = arg.value;
                        if (val === null) {
                            val = "";
                            const index = headers.findIndex((header) => header[0].toLowerCase() === "content-type");
                            if (index !== -1) {
                                headers.splice(index, 1);
                            }
                        }
                        if (typeof val === "boolean") {
                            if (!headers.some((header) => header[0].toLowerCase() === "content-type")) {
                                headers.push(["content-type", "application/json; charset=utf-8"]);
                            } else {
                                /** @type {any} */ (
                                    headers.find((header) => header[0].toLowerCase() === "content-type")
                                )[1] = "application/json; charset=utf-8";
                            }
                        }
                        body.push({ type: "text", value: val });
                    } else if (arg.type === "TemplateLiteral") {
                        const exprs = [...arg.quasis, ...arg.expressions].sort((a, b) => a.start - b.start);
                        for (const expr of exprs) {
                            if (expr.type === "TemplateElement") {
                                body.push({ type: "text", value: expr.value.cooked });
                            } else if (expr.type === "MemberExpression") {
                                const obj = expr.object;
                                let type;
                                if (obj.type === "MemberExpression") {
                                    if (obj.property.type !== "Identifier") {
                                        return false;
                                    }
                                    type = obj.property.name;
                                } else if (obj.type === "Identifier") {
                                    type = obj.name;
                                } else {
                                    return false;
                                }
                                if (type !== "params" && type !== "query") {
                                    return false;
                                }
                                body.push({ type, value: expr.property.name });
                            } else if (expr.type === "Identifier") {
                                if (queries.includes(expr.name)) {
                                    body.push({ type: "query", value: expr.name });
                                } else if (params.includes(expr.name)) {
                                    body.push({ type: "params", value: expr.name });
                                } else {
                                    return false;
                                }
                            } else {
                                return false;
                            }
                        }
                    } else if (arg.type === "MemberExpression") {
                        if (!arg.object.property) {
                            return false;
                        }
                        if (
                            arg.object.property.type !== "Identifier" ||
                            (arg.object.property.name !== "query" && arg.object.property.name !== "params")
                        ) {
                            return false;
                        }
                        body.push({ type: arg.object.property.name, value: arg.property.name });
                    } else if (arg.type === "BinaryExpression") {
                        const stuff = [];
                        function check(node) {
                            if (node.right.type === "Literal") {
                                stuff.push({ type: "text", value: node.right.value });
                            } else if (node.right.type === "MemberExpression") {
                                stuff.push({ type: node.right.object.property.name, value: node.right.property.name });
                            } else return false;
                            if (node.left.type === "Literal") {
                                stuff.push({ type: "text", value: node.left.value });
                            } else if (node.left.type === "MemberExpression") {
                                stuff.push({ type: node.left.object.property.name, value: node.left.property.name });
                            } else if (node.left.type === "BinaryExpression") {
                                return check(node.left);
                            } else return false;

                            return true;
                        }
                        if (!check(arg)) {
                            return false;
                        }
                        body.push(...stuff.reverse());
                    } else if (arg.type === "ObjectExpression") {
                        if (call.obj.propertyName === "end") {
                            return false;
                        }
                        // only simple objects can be optimized
                        let objCode = code;
                        for (const property of arg.properties) {
                            if (property.key.type !== "Identifier" && property.key.type !== "Literal") {
                                return false;
                            }
                            if (
                                property.value.raw.startsWith("'") &&
                                property.value.raw.endsWith("'") &&
                                !property.value.value.includes("'")
                            ) {
                                objCode = replaceSingleCharacter(objCode, property.value.start, '"');
                                objCode = replaceSingleCharacter(objCode, property.value.end - 1, '"');
                            }
                            if (property.value.type !== "Literal") {
                                return false;
                            }
                        }
                        if (
                            typeof app.get("json replacer") !== "undefined" &&
                            typeof app.get("json replacer") !== "string"
                        ) {
                            return false;
                        }

                        if (!headers.some((header) => header[0].toLowerCase() === "content-type")) {
                            headers.push(["content-type", "application/json; charset=utf-8"]);
                        } else {
                            /** @type {any} */ (
                                headers.find((header) => header[0].toLowerCase() === "content-type")
                            )[1] = "application/json; charset=utf-8";
                        }
                        body.push({
                            type: "text",
                            value: stringify(
                                JSON.parse(objCode.slice(arg.start, arg.end).replace(objKeyRegex, '"$1":')),
                                app.get("json replacer"),
                                app.get("json spaces"),
                                app.get("json escape")
                            )
                        });
                    } else {
                        return false;
                    }
                }
                sendUsed = true;
            }
        }

        let decRes = new uWSAny.DeclarativeResponse();

        if (statusCode != 200) {
            const statusMessage = statuses.message[statusCode] ?? "";
            decRes = decRes.writeStatus(`${statusCode} ${statusMessage}`.trim());
            if (!headers.some((header) => header[0].toLowerCase() === "content-type")) {
                decRes = decRes.writeHeader("content-type", "text/plain; charset=utf-8");
            }
        }

        for (const header of headers) {
            if (header[0].toLowerCase() === "content-length") {
                return false;
            }
            decRes = decRes.writeHeader(header[0], header[1]);
        }

        // sendStatus sends the status message as its body. It has to join `body` here, before the
        // ETag is computed, and not at write time: computing the ETag over an empty body gave every
        // sendStatus response the same one, so a cache could not tell a 404 from a 500 and a
        // conditional request could be answered 304 with the wrong body entirely.
        if (sendStatusUsed && !body.length) {
            body.push({ type: "text", value: statuses.message[statusCode] || String(statusCode) });
        }

        // an empty body gets no ETag, which is what Express does and what the ordinary path here
        // already did
        if (body.length && app.get("etag") && !headers.some((header) => header[0].toLowerCase() === "etag")) {
            if (body.some((part) => part.type !== "text")) {
                return false;
            } else {
                decRes = decRes.writeHeader(
                    "ETag",
                    app.get("etag fn")(body.map((part) => part.value.toString()).join(""))
                );
            }
        }

        if (app.get("x-powered-by")) {
            decRes = decRes.writeHeader("x-powered-by", "Fulmine");
        }

        for (const bodyPart of body) {
            if (bodyPart.type === "text" && String(bodyPart.value).length) {
                decRes = decRes.write(String(bodyPart.value));
            } else if (bodyPart.type === "params") {
                decRes = decRes.writeParameterValue(bodyPart.value);
            } else if (bodyPart.type === "query") {
                decRes = decRes.writeQueryValue(bodyPart.value);
            }
        }

        return decRes.end();
    } catch (e) {
        return false;
    }
};

function filterNodes(node, fn) {
    const filtered = [];
    if (fn(node)) {
        filtered.push(node);
    }
    if (node.params) {
        for (const param of node.params) {
            filtered.push(...filterNodes(param, fn));
        }
    }

    if (node.body) {
        if (Array.isArray(node.body)) {
            for (const child of node.body) {
                filtered.push(...filterNodes(child, fn));
            }
        } else {
            filtered.push(...filterNodes(node.body, fn));
        }
    }

    if (node.declarations) {
        for (const declaration of node.declarations) {
            filtered.push(...filterNodes(declaration, fn));
        }
    }

    if (node.expression) {
        filtered.push(...filterNodes(node.expression, fn));
    }

    if (node.callee) {
        filtered.push(...filterNodes(node.callee, fn));
    }

    if (node.object) {
        filtered.push(...filterNodes(node.object, fn));
    }

    if (node.property) {
        filtered.push(...filterNodes(node.property, fn));
    }

    if (node.id) {
        filtered.push(...filterNodes(node.id, fn));
    }
    if (node.init) {
        filtered.push(...filterNodes(node.init, fn));
    }

    if (node.left) {
        filtered.push(...filterNodes(node.left, fn));
    }
    if (node.right) {
        filtered.push(...filterNodes(node.right, fn));
    }

    if (node.arguments) {
        for (const argument of node.arguments) {
            filtered.push(...filterNodes(argument, fn));
        }
    }

    return filtered;
}
