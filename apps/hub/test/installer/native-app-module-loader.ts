import {
	type BinaryExpression,
	isArrowFunction,
	isBinaryExpression,
	isCallExpression,
	isExpressionStatement,
	isFunctionDeclaration,
	isIdentifier,
	isPropertyAccessExpression,
	isStringLiteralLikeNode,
	isTemplateExpression,
	isVariableDeclaration,
	isVariableDeclarationList,
	type Node,
	SyntaxKind,
	type VariableDeclaration,
} from "typescript/unstable/ast";

const named = (node: Node | undefined, name: string): boolean =>
	node !== undefined && isIdentifier(node) && node.text === name;

function verifiedDataImport(
	ast: Node,
	node: Node,
	helper: VariableDeclaration,
	arrow: Node,
): string {
	const declaration = helper.parent;
	if (
		!isVariableDeclarationList(declaration) ||
		declaration.parent.parent !== ast ||
		!arrow ||
		!isArrowFunction(arrow) ||
		(arrow.modifiers?.length ?? 0) !== 0 ||
		arrow.parameters.length !== 1
	)
		return "binding";
	const parameter = arrow.parameters[0];
	const body = arrow.body;
	if (
		!parameter ||
		!named(parameter.name, "verified") ||
		parameter.initializer ||
		parameter.dotDotDotToken ||
		parameter.questionToken ||
		!isTemplateExpression(body) ||
		body.head.text !== "data:text/javascript;base64," ||
		body.templateSpans.length !== 1
	)
		return "data-template";
	const span = body.templateSpans[0];
	if (!span || span.literal.text !== "" || !isCallExpression(span.expression)) return "data-span";
	const encode = span.expression;
	const method = encode.expression;
	const encoding = encode.arguments[0];
	if (
		encode.questionDotToken ||
		encode.arguments.length !== 1 ||
		!encoding ||
		!isStringLiteralLikeNode(encoding) ||
		encoding.text !== "base64" ||
		!isPropertyAccessExpression(method) ||
		method.questionDotToken ||
		!named(method.name, "toString") ||
		!isPropertyAccessExpression(method.expression) ||
		method.expression.questionDotToken ||
		!named(method.expression.name, "entry") ||
		!named(method.expression.expression, "verified") ||
		!isCallExpression(node) ||
		node.arguments.length !== 1
	)
		return "base64-encoding";
	const call = node.arguments[0];
	if (
		!call ||
		!isCallExpression(call) ||
		call.questionDotToken ||
		!named(call.expression, "moduleUrl") ||
		call.arguments.length !== 1 ||
		!named(call.arguments[0], "verified")
	)
		return "import-call";
	const callback = node.parent;
	const settle = callback.parent;
	if (
		!isArrowFunction(callback) ||
		callback.body !== node ||
		callback.parameters.length !== 0 ||
		(callback.modifiers?.length ?? 0) !== 0 ||
		!isCallExpression(settle) ||
		!named(settle.expression, "settleWithin") ||
		settle.arguments.length !== 3 ||
		settle.arguments[0] !== callback ||
		!named(settle.arguments[1], "MODULE_TIMEOUT_MS") ||
		!named(settle.arguments[2], "clock")
	)
		return "settle-callback";
	let owner = node.parent;
	while (owner !== ast && !isFunctionDeclaration(owner)) owner = owner.parent;
	if (
		!isFunctionDeclaration(owner) ||
		owner.parent !== ast ||
		!named(owner.name, "loadModule") ||
		owner.parameters.length !== 2 ||
		!named(owner.parameters[0]?.name, "verified") ||
		!named(owner.parameters[1]?.name, "clock") ||
		!owner.body
	)
		return "load-module";
	let statement: Node = node;
	while (statement.parent !== owner.body) statement = statement.parent;
	const index = owner.body.statements.findIndex((candidate) => candidate === statement);
	const reverified = owner.body.statements.slice(0, index).some((candidate) => {
		if (!isExpressionStatement(candidate) || !isCallExpression(candidate.expression)) return false;
		const reverify = candidate.expression;
		return (
			!reverify.questionDotToken &&
			named(reverify.expression, "reverifyModule") &&
			reverify.arguments.length === 1 &&
			named(reverify.arguments[0], "verified")
		);
	});
	return reverified ? "verified-data-loader" : "reverify";
}

export function assertNativeAppModuleLoader(ast: Node): void {
	const dataImports: Node[] = [];
	const dataHelpers: VariableDeclaration[] = [];
	const references: Node[] = [];
	const assignments: BinaryExpression[] = [];
	const helperRoleRows: string[] = [];
	function visit(node: Node, parent?: Node): void {
		if (named(node, "moduleUrl")) {
			references.push(node);
			// Bits: parent name, expression, propertyName, object, call, declaration.
			const roles = [
				parent !== undefined && "name" in parent && parent.name === node,
				parent !== undefined && "expression" in parent && parent.expression === node,
				parent !== undefined && "propertyName" in parent && parent.propertyName === node,
				parent !== undefined && "object" in parent && parent.object === node,
				parent !== undefined && isCallExpression(parent),
				parent !== undefined && isVariableDeclaration(parent),
			]
				.map((value) => (value ? 1 : 0))
				.join("");
			const row = `${node.pos},${node.end},${parent?.kind ?? -1},${roles}`;
			if (helperRoleRows.length < 8 && helperRoleRows.join(";").length + row.length + 1 <= 256)
				helperRoleRows.push(row);
		}
		if (isVariableDeclaration(node) && named(node.name, "moduleUrl")) dataHelpers.push(node);
		if (isBinaryExpression(node) && named(node.left, "moduleUrl")) assignments.push(node);
		if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
			const arg = node.arguments[0];
			if (!arg || !isStringLiteralLikeNode(arg)) dataImports.push(node);
		}
		node.forEachChild((child) => visit(child, node));
	}
	visit(ast);
	function counts(): never {
		throw new Error(
			`DYTEST import shape counts imports=${dataImports.length} helpers=${dataHelpers.length} uses=${references.length} roles=${helperRoleRows.join(";")}`,
		);
	}
	const helper = dataHelpers[0],
		dataImport = dataImports[0];
	if (dataImports.length !== 1 || dataHelpers.length !== 1 || !helper || !dataImport) counts();
	const call = isCallExpression(dataImport) ? dataImport.arguments[0] : undefined;
	if (!call || !isCallExpression(call) || !named(call.expression, "moduleUrl")) counts();
	let arrow = helper.initializer;
	let assignment: BinaryExpression | undefined;
	if (arrow) {
		if (assignments.length !== 0) counts();
	} else {
		assignment = assignments[0];
		if (
			assignments.length !== 1 ||
			!assignment ||
			assignment.operatorToken.kind !== SyntaxKind.EqualsToken ||
			!isExpressionStatement(assignment.parent)
		)
			counts();
		arrow = assignment.right;
	}
	const permitted = new Set<Node>([helper.name, call.expression]);
	if (assignment) permitted.add(assignment.left);
	if (references.length !== permitted.size || !references.every((node) => permitted.has(node)))
		counts();
	const category = verifiedDataImport(ast, dataImport, helper, arrow);
	if (category !== "verified-data-loader")
		throw new Error(`DYTEST import shape category=${category}`);
}
