import { defineRule, type ESTree } from "@oxlint/plugins";

const EFFECT_GENERATOR_BUILDERS = new Set(["gen", "fn", "fnUntraced"]);

const isEffectBuilder = (callee: ESTree.Node): boolean => {
  if (callee.type === "CallExpression") return isEffectBuilder(callee.callee);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Effect" &&
    callee.property.type === "Identifier" &&
    EFFECT_GENERATOR_BUILDERS.has(callee.property.name)
  );
};

const isEffectGeneratorBody = (node: ESTree.Node): boolean =>
  node.type === "FunctionExpression" &&
  node.generator &&
  node.parent?.type === "CallExpression" &&
  node.parent.arguments.some((argument) => argument === node) &&
  isEffectBuilder(node.parent.callee);

const isFunction = (node: ESTree.Node): boolean =>
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "ArrowFunctionExpression";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Fail an Effect generator with `yield* Effect.fail(...)` instead of `throw`, which becomes an untyped defect.",
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        let current: ESTree.Node | null | undefined = node.parent;
        while (current && !isFunction(current)) current = current.parent;
        if (!current || !isEffectGeneratorBody(current)) return;
        context.report({
          node,
          message:
            "Do not throw inside an Effect generator: it becomes an untyped defect. `return yield* new TaggedError(...)` or `yield* Effect.fail(...)` so callers can handle it.",
        });
      },
    };
  },
});
