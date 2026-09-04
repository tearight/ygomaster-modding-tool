import { Body1, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { useMemo } from 'react';

import type { ScopedDeckCandidate } from '../chapter/ScopedDeckPicker';
import { AuthoredChapterDraft, ChapterDuelFields } from './ChapterComposer';

const useStyles = makeStyles({
  container: {
    display: 'grid',
    gridTemplateColumns: 'minmax(360px, 1fr) minmax(340px, 0.72fr)',
    gap: tokens.spacingHorizontalL,
    '@media (max-width: 1100px)': { gridTemplateColumns: '1fr' },
  },
  graph: { display: 'grid', gap: tokens.spacingVerticalS, alignContent: 'start' },
  canvas: { height: '480px', minWidth: 0, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  quick: { display: 'grid', gap: tokens.spacingVerticalM, alignContent: 'start' },
});

interface GateGraphQuickEditorProps {
  chapters: readonly AuthoredChapterDraft[];
  selectedChapterId?: string;
  folderLabel: string;
  cpuCandidates: readonly ScopedDeckCandidate[];
  rentalCandidates: readonly ScopedDeckCandidate[];
  onSelect: (chapterId: string) => void;
  onChange: (chapter: AuthoredChapterDraft) => void;
  onOpenFull?: (chapterId: string) => void;
}

interface ChapterNodeData extends Record<string, unknown> {
  label: string;
}

const graphDepth = (
  chapter: AuthoredChapterDraft,
  byId: ReadonlyMap<string, AuthoredChapterDraft>,
): number => {
  let depth = 0;
  let current = chapter;
  const seen = new Set([chapter.id]);
  while (current.parent) {
    const parent = byId.get(current.parent);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
    depth += 1;
  }
  return depth;
};

export const buildAuthoredChapterGraph = (
  chapters: readonly AuthoredChapterDraft[],
  selectedChapterId?: string,
): { nodes: Node<ChapterNodeData>[]; edges: Edge[] } => {
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const rows = new Map<number, number>();
  const nodes = chapters.map((chapter) => {
    const depth = graphDepth(chapter, byId);
    const row = rows.get(depth) || 0;
    rows.set(depth, row + 1);
    return {
      id: chapter.id,
      position: { x: depth * 250, y: row * 110 },
      data: { label: chapter.id },
      selected: chapter.id === selectedChapterId,
      style: {
        width: 190,
        borderColor: chapter.id === selectedChapterId ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1,
        background: tokens.colorNeutralBackground1,
      },
    } satisfies Node<ChapterNodeData>;
  });
  const edges = chapters.flatMap((chapter) => chapter.parent && byId.has(chapter.parent)
    ? [{
      id: `${chapter.parent}->${chapter.id}`,
      source: chapter.parent,
      target: chapter.id,
      markerEnd: { type: MarkerType.ArrowClosed },
    } satisfies Edge]
    : []);
  return { nodes, edges };
};

export const GateGraphQuickEditor = ({
  chapters,
  selectedChapterId,
  folderLabel,
  cpuCandidates,
  rentalCandidates,
  onSelect,
  onChange,
  onOpenFull,
}: GateGraphQuickEditorProps) => {
  const classes = useStyles();
  const selected = chapters.find((chapter) => chapter.id === selectedChapterId) || chapters[0];
  const graph = useMemo(() => buildAuthoredChapterGraph(chapters, selected?.id), [chapters, selected?.id]);
  return <section className={classes.container} aria-label="Gate graph quick editor">
    <div className={classes.graph}>
      <Body1>Chapter graph</Body1>
      <Caption1>Previous Chapter → Chapter. Pan, zoom, fit, or select a node; relations remain symbolic authored fields.</Caption1>
      <div className={classes.canvas}>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => onSelect(node.id)}
          onNodeDoubleClick={(_, node) => onOpenFull?.(node.id)}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
    <div className={classes.quick}>
      <Body1>Selected Chapter quick edit</Body1>
      {selected ? <ChapterDuelFields chapter={selected} chapters={chapters} folderLabel={folderLabel} cpuCandidates={cpuCandidates} rentalCandidates={rentalCandidates} onChange={onChange} /> : <Caption1>Create a Chapter before editing the graph.</Caption1>}
    </div>
  </section>;
};
