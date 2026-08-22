import { CatalogCard } from './types';

export type CatalogNumericField = 'level' | 'rank' | 'link' | 'scale' | 'atk' | 'def' | 'availability';
export type CatalogSortField = 'id' | 'name' | CatalogNumericField;

export type CatalogExpression =
  | { kind: 'text'; field: 'any' | 'name' | 'effect'; value: string; mode: 'contains' | 'prefix' }
  | { kind: 'exact'; field: 'id' | 'ydkId' | 'name' | 'tag'; value: string | number }
  | { kind: 'range'; field: CatalogNumericField; gt?: number; gte?: number; lt?: number; lte?: number }
  | { kind: 'and'; terms: CatalogExpression[] }
  | { kind: 'or'; terms: CatalogExpression[] }
  | { kind: 'not'; term: CatalogExpression };

export interface CatalogQueryDocument {
  card: CatalogCard;
  anyText: string;
  nameText: string;
  names: ReadonlySet<string>;
  effectText: string;
  tags: ReadonlySet<string>;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

const terms = (query: string): string[] =>
  (query.match(/"(?:\\.|[^"\\])*"|\S+/gu) || []).map((term) => {
    if (term.startsWith('"') && term.endsWith('"')) return term.slice(1, -1).replace(/\\"/g, '"');
    return term;
  });

const numericFields = new Set<CatalogNumericField>(['level', 'rank', 'link', 'scale', 'atk', 'def', 'availability']);

const parseTerm = (raw: string): CatalogExpression => {
  const value = normalize(raw);
  const range = value.match(/^(level|rank|link|scale|atk|def|availability)(>=|<=|>|<|=)(-?\d+)$/u);
  if (range) {
    const field = range[1] as CatalogNumericField;
    const number = Number(range[3]);
    if (range[2] === '>') return { kind: 'range', field, gt: number };
    if (range[2] === '>=') return { kind: 'range', field, gte: number };
    if (range[2] === '<') return { kind: 'range', field, lt: number };
    if (range[2] === '<=') return { kind: 'range', field, lte: number };
    return { kind: 'range', field, gte: number, lte: number };
  }
  if (value.startsWith('-') && value.length > 1) return { kind: 'not', term: parseTerm(value.slice(1)) };
  if (value.startsWith('name^:') && value.length > 6) return { kind: 'text', field: 'name', value: value.slice(6), mode: 'prefix' };
  if (value.startsWith('name:') && value.length > 5) return { kind: 'exact', field: 'name', value: value.slice(5) };
  const colon = value.indexOf(':');
  if (colon >= 0) {
    const field = value.slice(0, colon);
    const exactValue = value.slice(colon + 1);
    if (field === 'id') return { kind: 'exact', field: 'id', value: Number(exactValue) };
    if (field === 'ydk') return { kind: 'exact', field: 'ydkId', value: Number(exactValue) };
    return { kind: 'exact', field: 'tag', value };
  }
  return { kind: 'text', field: 'any', value, mode: 'contains' };
};

export const parseCatalogQuery = (query: string): CatalogExpression => ({
  kind: 'and',
  terms: terms(query).map(parseTerm),
});

const numericValue = (card: CatalogCard, field: CatalogNumericField): number | undefined =>
  field === 'availability' ? card.availability : card.stats[field];

export const evaluateCatalogExpression = (expression: CatalogExpression, document: CatalogQueryDocument): boolean => {
  if (expression.kind === 'and') return expression.terms.every((term) => evaluateCatalogExpression(term, document));
  if (expression.kind === 'or') return expression.terms.some((term) => evaluateCatalogExpression(term, document));
  if (expression.kind === 'not') return !evaluateCatalogExpression(expression.term, document);
  if (expression.kind === 'text') {
    const text = expression.field === 'name' ? document.nameText : expression.field === 'effect' ? document.effectText : document.anyText;
    return expression.mode === 'prefix' ? text.startsWith(expression.value) : text.includes(expression.value);
  }
  if (expression.kind === 'exact') {
    if (expression.field === 'id') return document.card.id === expression.value;
    if (expression.field === 'ydkId') return document.card.ydkId === expression.value;
    if (expression.field === 'name') return document.names.has(String(expression.value));
    return document.tags.has(String(expression.value));
  }
  const value = numericValue(document.card, expression.field);
  if (value === undefined) return false;
  if (expression.gt !== undefined && value <= expression.gt) return false;
  if (expression.gte !== undefined && value < expression.gte) return false;
  if (expression.lt !== undefined && value >= expression.lt) return false;
  if (expression.lte !== undefined && value > expression.lte) return false;
  return true;
};

export const compareCatalogCards = (
  left: CatalogCard,
  right: CatalogCard,
  field: CatalogSortField,
  direction: 'asc' | 'desc',
): number => {
  const multiplier = direction === 'asc' ? 1 : -1;
  let compared = 0;
  if (field === 'id') compared = left.id - right.id;
  else if (field === 'name') compared = left.names.display.localeCompare(right.names.display);
  else compared = (numericValue(left, field) ?? Number.NEGATIVE_INFINITY) - (numericValue(right, field) ?? Number.NEGATIVE_INFINITY);
  return compared === 0 ? left.id - right.id : compared * multiplier;
};

export const isCatalogSortField = (value: string): value is CatalogSortField =>
  value === 'id' || value === 'name' || numericFields.has(value as CatalogNumericField);
