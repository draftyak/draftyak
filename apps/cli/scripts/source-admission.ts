import {
	isArrayLiteralExpression,
	isAsExpression,
	isBinaryExpression,
	isBindingElement,
	isCallExpression,
	isComputedPropertyName,
	isElementAccessExpression,
	isExportDeclaration,
	isExportSpecifier,
	isForInStatement,
	isForOfStatement,
	isIdentifier,
	isImportDeclaration,
	isMethodDeclaration,
	isNonNullExpression,
	isObjectLiteralExpression,
	isParenthesizedExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isSatisfiesExpression,
	isSpreadAssignment,
	isSpreadElement,
	isStringLiteral,
	isStringLiteralLikeNode,
	isTypeAssertion,
	type Node,
	SyntaxKind,
} from "typescript/unstable/ast";

const runtimeLoaderFields = new Set(["getBuiltinModule", "mainModule"]);
const reservedLiteralFields = new Set([...runtimeLoaderFields, "process"]);
const runtimeLoaderModules = new Set(["module", "node:module", "process", "node:process"]);

function transparentExpression(node: Node): Node {
	let value = node;
	while (
		isParenthesizedExpression(value) ||
		isAsExpression(value) ||
		isSatisfiesExpression(value) ||
		isTypeAssertion(value) ||
		isNonNullExpression(value)
	)
		value = value.expression;
	return value;
}

function literalField(node: Node | undefined): string | undefined {
	const expression = node && isComputedPropertyName(node) ? node.expression : node;
	const value = expression && transparentExpression(expression);
	return value && isStringLiteralLikeNode(value) ? value.text : undefined;
}

function processName(node: Node): boolean {
	const parent = node.parent;
	return (
		((isMethodDeclaration(parent) || isPropertyAssignment(parent)) && parent.name === node) ||
		(isExportSpecifier(parent) && parent.name === node && parent.propertyName !== undefined)
	);
}

/** Checks syntax admitted by the installed relative ESM payload. */
export function assertSourceAdmission(ast: Node, moduleLoader: boolean = false): readonly string[] {
	const specifiers: string[] = [];
	const assignmentPatterns = new WeakSet<Node>();
	function assignmentPattern(node: Node): void {
		const value = transparentExpression(node);
		if (assignmentPatterns.has(value)) return;
		assignmentPatterns.add(value);
		if (isObjectLiteralExpression(value)) {
			for (const property of value.properties) {
				if (isPropertyAssignment(property)) {
					const field = isIdentifier(property.name)
						? property.name.text
						: literalField(property.name);
					if (field !== undefined && reservedLiteralFields.has(field))
						throw new Error("CLI build refused.");
					assignmentPattern(property.initializer);
				} else if (isSpreadAssignment(property)) assignmentPattern(property.expression);
			}
		} else if (isArrayLiteralExpression(value)) {
			for (const element of value.elements) assignmentPattern(element);
		} else if (isSpreadElement(value)) assignmentPattern(value.expression);
		else if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.EqualsToken)
			assignmentPattern(value.left);
	}
	function specifier(value: string): void {
		if (runtimeLoaderModules.has(value)) throw new Error("CLI build refused.");
		specifiers.push(value);
	}
	function visit(node: Node): void {
		if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken)
			assignmentPattern(node.left);
		else if (isForInStatement(node) || isForOfStatement(node)) assignmentPattern(node.initializer);
		if (
			isIdentifier(node) &&
			(runtimeLoaderFields.has(node.text) ||
				(node.text === "process" &&
					!processName(node) &&
					!(isPropertyAccessExpression(node.parent) && node.parent.expression === node)))
		)
			throw new Error("CLI build refused.");
		const field = isBindingElement(node)
			? literalField(node.propertyName)
			: isElementAccessExpression(node)
				? literalField(node.argumentExpression)
				: undefined;
		if (field !== undefined && reservedLiteralFields.has(field))
			throw new Error("CLI build refused.");
		if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier) {
			if (!isStringLiteral(node.moduleSpecifier)) throw new Error("CLI build refused.");
			specifier(node.moduleSpecifier.text);
		}
		if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			if (argument && isStringLiteral(argument)) specifier(argument.text);
			else if (!moduleLoader) throw new Error("CLI build refused.");
		}
		node.forEachChild(visit);
	}
	visit(ast);
	return Object.freeze(specifiers);
}
