/**
 * Compose one dynamic agent preset from a console definition and a template preset.
 *
 * Cloning the template's declared plugin list keeps created agents aligned with
 * the deployment's tool composition; only the persona prefix is replaced.
 *
 * @module @gac2/dsh-aiops-agent-controller/preset
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentDefinition } from './store.ts'

const PERSONA_MODULE = '@deepseek-ai/dsh-persona'

/**
 * Build the preset declaration for one console-managed agent.
 * @param definition - console-managed agent definition.
 * @param template - deployment template preset (usually the builtin OS agent).
 * @returns a preset declaration whose persona plugin carries the definition's prefix.
 */
export function composeAgentPreset(definition: AgentDefinition, template: PresetDefinition): PresetDefinition {
  const plugins = template.plugins.map((entry) => {
    if (entry.name !== PERSONA_MODULE) return entry
    const config = typeof entry.config === 'object' && entry.config !== null && !Array.isArray(entry.config)
      ? entry.config as Record<string, unknown>
      : {}
    return { ...entry, config: { ...config, prefix: definition.personaPrefix } }
  })
  return { id: definition.id, name: definition.name, description: definition.role, plugins }
}
