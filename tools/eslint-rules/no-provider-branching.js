/**
 * Forbids branching on a vendor identity.
 *
 * The Agent Runtime must read capabilities as DATA (ModelCapabilities) rather
 * than ask which vendor it is talking to. `if (provider === 'anthropic')` is how
 * every "provider-agnostic" system dies — one urgent fix at a time.
 *
 * Catches:
 *   provider === 'anthropic'            (any comparison against a vendor literal)
 *   switch (providerType) { case 'openai': ... }
 *   ['anthropic', 'openai'].includes(x)
 *
 * The fix is always the same: add a field to ModelCapabilities and branch on that.
 */
const VENDORS = new Set([
  'anthropic', 'openai', 'google', 'gemini', 'bedrock', 'vertex',
  'azure', 'mistral', 'cohere', 'ollama', 'groq', 'together',
]);

const MESSAGE =
  "Do not branch on vendor identity ('{{vendor}}'). Express the difference as a " +
  'ModelCapabilities field and branch on that instead. See docs/PROVIDER-ABSTRACTION.md §1.';

const isVendorLiteral = (node) =>
  node?.type === 'Literal' &&
  typeof node.value === 'string' &&
  VENDORS.has(node.value.toLowerCase());

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow branching on AI provider identity' },
    schema: [],
    messages: { noBranching: MESSAGE },
  },
  create(context) {
    const report = (node, vendor) =>
      context.report({ node, messageId: 'noBranching', data: { vendor } });

    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (isVendorLiteral(side)) return report(node, side.value);
        }
      },
      SwitchCase(node) {
        if (isVendorLiteral(node.test)) report(node, node.test.value);
      },
      'CallExpression > MemberExpression[property.name=/^(includes|has|indexOf)$/]'(node) {
        const call = node.parent;
        for (const arg of call.arguments) {
          if (isVendorLiteral(arg)) return report(call, arg.value);
        }
        if (node.object?.type === 'ArrayExpression') {
          for (const el of node.object.elements) {
            if (isVendorLiteral(el)) return report(call, el.value);
          }
        }
      },
    };
  },
};
