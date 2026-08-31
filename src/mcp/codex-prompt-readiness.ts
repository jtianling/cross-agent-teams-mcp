/**
 * Positive evidence that a codex pane is sitting at a composer that will read
 * an injected line as input.
 *
 * An ALLOWLIST on purpose.  The quiet guard only proves the tail stopped
 * moving, and a blocking TUI menu awaiting a keypress is quieter than a live
 * prompt — so enumerating known-dangerous screens would leave every menu we
 * have not met yet accepted by default, and the injection ends in an
 * irreversible Enter.  Refusing wrongly costs an unrecovered pane, which is
 * logged, retried, and bounded by the pre-registration row's expiry.
 *
 * The marker is the composer's prompt prefix rather than its placeholder
 * wording: codex draws the placeholder from a randomised set, while
 * `bottom_pane/chat_composer.rs` renders this glyph at the fixed left edge of
 * the textarea.  Bash mode renders `!` instead and is deliberately not ready.
 */

/** Refusal reason for a pane that shows no composer prompt.  Distinct from
 *  `guard_failed`: were the composer's rendering to change, every codex pane
 *  would refuse at once, and a shared reason would blame a moving screen. */
export const PROMPT_NOT_READY = 'prompt_not_ready'

const COMPOSER_PROMPT_PREFIX = '›'

export function isCodexComposerReady(paneTail: string): boolean {
  return paneTail
    .split('\n')
    .some(line => line.trimStart().startsWith(COMPOSER_PROMPT_PREFIX))
}
