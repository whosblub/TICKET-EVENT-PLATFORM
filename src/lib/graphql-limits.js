import { GraphQLError, Kind } from 'graphql';

export const gqlError = (message, code, extra = {}) => new GraphQLError(message, { extensions: { code, ...extra } });

export function createLimitsRule({ maxDepth = 5, maxFields = 100 } = {}) {
  return function limitsRule(context) {
    const LIMIT = Symbol('limit');
    return {
      Document(doc) {
        const frags = new Map();
        for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) frags.set(d.name.value, d);
        let fields = 0;
        let deepest = 0;
        const walk = (set, depth, stack) => {
          for (const sel of set.selections) {
            if (sel.kind === Kind.FIELD) {
              if (sel.name.value.startsWith('__')) continue;
              fields += 1;
              deepest = Math.max(deepest, depth + 1);
              if (fields > maxFields || deepest > maxDepth) throw LIMIT;
              if (sel.selectionSet) walk(sel.selectionSet, depth + 1, stack);
            } else if (sel.kind === Kind.INLINE_FRAGMENT) {
              walk(sel.selectionSet, depth, stack);
            } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
              const f = frags.get(sel.name.value);
              if (f && !stack.has(f.name.value)) walk(f.selectionSet, depth, new Set([...stack, f.name.value]));
            }
          }
        };
        try {
          for (const op of doc.definitions) if (op.kind === Kind.OPERATION_DEFINITION) walk(op.selectionSet, 0, new Set());
        } catch (e) {
          if (e !== LIMIT) throw e;
          context.reportError(gqlError(`Query terlalu kompleks (maksimum kedalaman ${maxDepth}, maksimum ${maxFields} field)`, 'QUERY_TOO_COMPLEX'));
        }
        return false;
      },
    };
  };
}