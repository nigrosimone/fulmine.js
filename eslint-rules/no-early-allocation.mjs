// A local rule: a const or let whose initializer allocates (a function, an array, an object, a
// new, a class), declared in a block that a later statement can leave with return, continue or
// break before the first statement that reads it. On that branch the allocation was paid for
// nothing, and moving the line down is free. A throw does not count as leaving: that branch is an
// error, and an allocation before it costs nothing next to the throw itself. A call does not count
// as an allocation: the call is often the work whose result the next line checks.

const ALLOC = new Set([
    "ArrowFunctionExpression",
    "FunctionExpression",
    "ArrayExpression",
    "ObjectExpression",
    "NewExpression",
    "ClassExpression"
]);
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOOP = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/** Whether running this statement can leave the block it is in before the statements after it. */
function canLeave(stmt, visitorKeys) {
    let found = false;
    const visit = (node, inLoop, inSwitch) => {
        if (!node || typeof node.type !== "string" || found || FN.has(node.type)) return;
        if (
            node.type === "ReturnStatement" ||
            (node.type === "ContinueStatement" && !inLoop) ||
            (node.type === "BreakStatement" && !inLoop && !inSwitch)
        ) {
            found = true;
            return;
        }
        const loop = inLoop || LOOP.has(node.type);
        const sw = inSwitch || node.type === "SwitchStatement";
        for (const key of visitorKeys[node.type] ?? []) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach((c) => visit(c, loop, sw));
            else visit(child, loop, sw);
        }
    };
    visit(stmt, false, false);
    return found;
}

/** The statement of `body` this node sits in. */
function statementIn(body, node) {
    let n = node;
    while (n && !body.includes(n)) n = n.parent;
    return n;
}

export default {
    meta: {
        type: "suggestion",
        docs: { description: "an allocation declared before a branch that leaves without reading it" },
        schema: []
    },
    create(context) {
        const sc = context.sourceCode;
        return {
            VariableDeclaration(node) {
                const parent = node.parent;
                if (parent.type !== "BlockStatement" && parent.type !== "Program") return;
                const body = parent.body;
                const at = body.indexOf(node);
                for (const decl of node.declarations) {
                    if (!decl.init || decl.id.type !== "Identifier" || !ALLOC.has(decl.init.type)) continue;
                    const refs = sc.getDeclaredVariables(decl)[0].references.filter((r) => r.identifier !== decl.id);
                    if (refs.length === 0) continue;
                    let first = Infinity;
                    for (const ref of refs) {
                        const stmt = statementIn(body, ref.identifier);
                        if (!stmt) return;
                        first = Math.min(first, body.indexOf(stmt));
                    }
                    for (let k = at + 1; k < first; k++) {
                        if (canLeave(body[k], sc.visitorKeys)) {
                            context.report({
                                node: decl.id,
                                message: `'${decl.id.name}' is built here, and line ${body[k].loc.start.line} can leave before line ${body[first].loc.start.line} reads it: declare it after the exit`
                            });
                            break;
                        }
                    }
                }
            }
        };
    }
};
