module.exports = {
  rules: {
    'no-transport-bypass-imports': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Disallow direct import of transport internals',
        },
        schema: [],
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const forbidden = [
              'src/transport/internal',
              'src/transport/adapter',
              'src/transport/legacyTransport',
            ];
            const importPath = node.source.value;
            if (forbidden.some(f => importPath.includes(f))) {
              context.report({
                node,
                message: `Forbidden transport import: ${importPath}`,
              });
            }
          },
        };
      },
    },
  },
};
