/** Decorative occupant for the aiops sidebar entry. */
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the sparkle glyph at the size the sidebar asks for; the sidebar owns
 * its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and selection state.
 * @returns decorative sparkle icon.
 */
export function AiopsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSparkleRegular size={size} />
}
