// Thin Cytoscape wrapper for the analysis topic graph. The panel owns the
// container; we just plug data in and forward node clicks back out.
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import type { AnalysisResult } from '../shared/ipc'

export interface GraphHandle {
  setData(result: AnalysisResult): void
  resize(): void
  destroy(): void
}

export function mountGraph(
  container: HTMLElement,
  onNodeClick: (id: string) => void
): GraphHandle {
  const cy: Core = cytoscape({
    container,
    elements: [],
    style: [
      {
        selector: 'node',
        style: {
          'background-color': '#eaf0ff',
          'border-color': '#3a6ff7',
          'border-width': 1,
          label: 'data(label)',
          color: '#1f1f1d',
          'font-size': '11px',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '80px',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'round-rectangle'
        }
      },
      {
        selector: 'node:active',
        style: { 'overlay-opacity': 0 }
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          width: 1,
          'line-color': '#c8c7c2',
          'target-arrow-shape': 'none',
          label: 'data(label)',
          'font-size': '10px',
          color: '#5a5a55',
          'text-background-color': '#ffffff',
          'text-background-opacity': 0.92,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'text-border-color': '#e2e0d9',
          'text-border-opacity': 1,
          'text-border-width': 1,
          // Horizontal text reads at a glance and never clips on short/steep
          // edges the way `autorotate` does.
          'text-rotation': 0,
          'text-wrap': 'wrap',
          'text-max-width': '120px'
        }
      }
    ],
    layout: { name: 'cose', animate: false, padding: 16 },
    wheelSensitivity: 0.2,
    autoungrabify: false
  })

  cy.on('tap', 'node', (evt) => {
    onNodeClick(evt.target.id() as string)
  })

  return {
    setData(result) {
      cy.elements().remove()
      const elements: ElementDefinition[] = [
        ...result.nodes.map((n) => ({ data: { id: n.id, label: n.title } })),
        ...result.edges
          // Drop edges pointing at nodes that weren't extracted — the model
          // occasionally invents an id; Cytoscape would throw on add otherwise.
          .filter((e) => result.nodes.some((n) => n.id === e.from) && result.nodes.some((n) => n.id === e.to))
          .map((e) => ({ data: { source: e.from, target: e.to, label: e.label } }))
      ]
      cy.add(elements)
      cy.layout({ name: 'cose', animate: false, padding: 16 }).run()
      cy.fit(undefined, 16)
    },
    resize() {
      cy.resize()
      cy.fit(undefined, 16)
    },
    destroy() {
      cy.destroy()
    }
  }
}
