import { Button, Caption1, Checkbox, Field, Input, makeStyles, tokens } from '@fluentui/react-components';
import { useState } from 'react';

export type RuntimePolicyFamily = 'settings' | 'shop' | 'client';
export interface RuntimePolicyFieldDefinition {
  family: RuntimePolicyFamily;
  key: string;
  kind: 'boolean' | 'integer' | 'positive-number' | 'object';
  group: 'profile' | 'tutorial-rules' | 'progression' | 'packs' | 'craft-rewards' | 'client';
  description: string;
  caveat?: string;
}

type Policy = Record<RuntimePolicyFamily, Record<string, unknown>>;
type Container = Record<string, unknown> | unknown[];

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: tokens.spacingHorizontalL },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  field: { borderLeft: `2px solid ${tokens.colorNeutralStroke2}`, paddingLeft: tokens.spacingHorizontalS },
  nested: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginLeft: tokens.spacingHorizontalM },
  row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  caveat: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

const groupTitles: Record<RuntimePolicyFieldDefinition['group'], string> = {
  profile: 'New profile economy',
  'tutorial-rules': 'Tutorial and rules',
  progression: 'Progression',
  packs: 'Pack policy',
  'craft-rewards': 'Craft and duel rewards',
  client: 'Client and speed',
};

const defaultValue = (kind: string): unknown => kind === 'object' ? {} : kind === 'array' ? [] : kind === 'boolean' ? false : kind === 'number' ? 0 : '';
const isContainer = (value: unknown): value is Container => Boolean(value && typeof value === 'object');

export const replaceNestedValue = (root: Container, path: Array<string | number>, value: unknown): Container => {
  if (path.length === 0) return value as Container;
  const [head, ...tail] = path;
  const copy: Container = Array.isArray(root) ? [...root] : { ...root };
  const current = copy[head as never];
  copy[head as never] = (tail.length === 0 ? value : replaceNestedValue(isContainer(current) ? current : {}, tail, value)) as never;
  return copy;
};

export const removeNestedValue = (root: Container, path: Array<string | number>): Container => {
  const [head, ...tail] = path;
  const copy: Container = Array.isArray(root) ? [...root] : { ...root };
  if (tail.length === 0) {
    if (Array.isArray(copy)) copy.splice(Number(head), 1);
    else delete copy[String(head)];
    return copy;
  }
  const current = copy[head as never];
  if (isContainer(current)) copy[head as never] = removeNestedValue(current, tail) as never;
  return copy;
};

const StructuredNode = ({ value, onChange, label, onRemove }: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  onRemove?: () => void;
}) => {
  const classes = useStyles();
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState('string');
  if (Array.isArray(value)) {
    return <div className={classes.nested}>
      <div className={classes.row}><Caption1>{label} (array)</Caption1>{onRemove && <Button size="small" onClick={onRemove}>Remove</Button>}</div>
      {value.map((entry, index) => <StructuredNode key={index} label={`[${index}]`} value={entry} onChange={(next) => onChange(replaceNestedValue(value, [index], next))} onRemove={() => onChange(removeNestedValue(value, [index]))} />)}
      <div className={classes.row}><select value={newType} onChange={(event) => setNewType(event.currentTarget.value)} aria-label={`${label} new item type`}><option value="object">object</option><option value="array">array</option><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option></select><Button size="small" onClick={() => onChange([...value, defaultValue(newType)])}>Add item</Button></div>
    </div>;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return <div className={classes.nested}>
      <div className={classes.row}><Caption1>{label} (object)</Caption1>{onRemove && <Button size="small" onClick={onRemove}>Remove</Button>}</div>
      {Object.entries(object).map(([key, entry]) => <StructuredNode key={key} label={key} value={entry} onChange={(next) => onChange({ ...object, [key]: next })} onRemove={() => { const next = { ...object }; delete next[key]; onChange(next); }} />)}
      <div className={classes.row}><Input size="small" value={newKey} onChange={(_, data) => setNewKey(data.value)} placeholder="Property name" aria-label={`${label} new property name`} /><select value={newType} onChange={(event) => setNewType(event.currentTarget.value)} aria-label={`${label} new property type`}><option value="object">object</option><option value="array">array</option><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option></select><Button size="small" disabled={!newKey || Object.prototype.hasOwnProperty.call(object, newKey)} onClick={() => { onChange({ ...object, [newKey]: defaultValue(newType) }); setNewKey(''); }}>Add property</Button></div>
    </div>;
  }
  if (typeof value === 'boolean') return <div className={classes.row}><Checkbox checked={value} label={label} onChange={(_, data) => onChange(data.checked === true)} />{onRemove && <Button size="small" onClick={onRemove}>Remove</Button>}</div>;
  return <div className={classes.row}><Field label={label}><Input size="small" type={typeof value === 'number' ? 'number' : 'text'} value={String(value ?? '')} onChange={(_, data) => onChange(typeof value === 'number' ? Number(data.value) : data.value)} /></Field>{onRemove && <Button size="small" onClick={onRemove}>Remove</Button>}</div>;
};

export const RuntimePolicyEditor = ({ policy, definitions, onChange }: {
  policy: Policy;
  definitions: readonly RuntimePolicyFieldDefinition[];
  onChange: (policy: Policy) => void;
}) => {
  const classes = useStyles();
  const update = (definition: RuntimePolicyFieldDefinition, value: unknown, enabled = true) => {
    const family = { ...policy[definition.family] };
    if (enabled) family[definition.key] = value;
    else delete family[definition.key];
    onChange({ ...policy, [definition.family]: family });
  };
  return <div className={classes.grid}>
    {Object.entries(groupTitles).map(([group, title]) => {
      const fields = definitions.filter((entry) => entry.group === group);
      if (fields.length === 0) return null;
      return <div className={classes.group} key={group}><strong>{title}</strong>{fields.map((definition) => {
        const enabled = Object.prototype.hasOwnProperty.call(policy[definition.family], definition.key);
        const value = policy[definition.family][definition.key];
        return <div className={classes.field} key={`${definition.family}.${definition.key}`}>
          <Checkbox checked={enabled} label={`${definition.key} (${definition.family})`} onChange={(_, data) => update(definition, definition.kind === 'object' ? {} : definition.kind === 'boolean' ? false : definition.kind === 'positive-number' ? 1 : 0, data.checked === true)} />
          <Caption1>{definition.description}</Caption1>
          {definition.caveat && <Caption1 className={classes.caveat}>{definition.caveat}</Caption1>}
          {enabled && definition.kind === 'boolean' && <Checkbox checked={value === true} label="Enabled" onChange={(_, data) => update(definition, data.checked === true)} />}
          {enabled && (definition.kind === 'integer' || definition.kind === 'positive-number') && <Input type="number" min={definition.kind === 'integer' ? 0 : 0.01} step={definition.kind === 'integer' ? 1 : 0.1} value={String(value)} onChange={(_, data) => update(definition, Number(data.value))} />}
          {enabled && definition.kind === 'object' && <StructuredNode label={definition.key} value={value && typeof value === 'object' && !Array.isArray(value) ? value : {}} onChange={(next) => update(definition, next)} />}
        </div>;
      })}</div>;
    })}
  </div>;
};
