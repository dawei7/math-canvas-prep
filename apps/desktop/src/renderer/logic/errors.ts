import { McPrepError, type Issue } from '@mcprep/core/pure';

/**
 * The core's messages are written for the command line and for agents: they often end with a command to type. The window
 * says the same thing in plain words: the message of the rule, and a hint only when the hint does not tell the person to
 * run a command.
 */

const COMMAND = /`|mcprep\b/;

/** "Operation 0 (add): ..." is how a batch names the step that failed; with a single step it only gets in the way. */
const STEP_PREFIX = /^Operation \d+ \([^)]*\):\s*/;

/** The sentence that explains why a printed exercise has no parts (the same wording as the core's refusal). */
export const NO_PARTS_REASON =
  'A book exercise is one printed exercise with one printed number. The parts of a printed exercise (5a and 5b) are two exercises with two numbers; what they share, the statement printed once above them, is attached to each of them as context. Cutting into parts is for exercises you frame for yourself.';

/** What went wrong, in plain words, for an error thrown by the core's operations (or anything else). */
export function plainError(error: unknown): string {
  if (!(error instanceof McPrepError)) return error instanceof Error ? error.message : String(error);
  const message = error.message.replace(STEP_PREFIX, '');
  switch (error.code) {
    case 'E_AUTHORITY_UNIT':
      return 'This exercise has parts, and a book exercise is a single exercise. Join its parts first, or draw each printed exercise on its own.';
    case 'E_SECTION':
      return 'Choose the section the exercise belongs to: an entry of the Sections list that has an id.';
    case 'E_SECTION_IN_USE':
      return `${message.replace(/;.*$/, '.')} Move them to another section first, or delete them.`;
    case 'E_DUPLICATE_EXERCISE':
      return `${message} Choose another number.`;
    case 'E_NO_SECTION':
      return 'That section does not exist (any more).';
    default: {
      const hint = error.hint !== undefined && !COMMAND.test(error.hint) ? ` ${error.hint}` : '';
      return `${COMMAND.test(message) ? message.replace(/\s*\([^()]*`[^()]*\)/g, '').replace(/`[^`]*`/g, '') : message}${hint}`;
    }
  }
}

/**
 * What to do about a validation issue, in the window's words. The core's `fix` is often a command line (`mcprep exercises
 * label ...`); for the rules about books the window says it in terms of what is on the screen. Other issues keep their fix.
 */
export function guiFix(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'duplicate-exercise':
      return 'Give one of them its own number (select it, change its number in the card at the top), or delete the copy.';
    case 'section-unknown':
      return 'File the exercise under another section (select it and choose the section in the card at the top), or add that section in the Sections list.';
    case 'label-style':
      return 'Write the number without the "." or ")" the book prints after it.';
    case 'section-mismatch':
      return 'Look at the page: file the exercise under the section it is printed in, or correct the section\'s page and position in the Sections list.';
    case 'solution-overlaps-frame':
    case 'solution-is-exercise':
      return 'A solution is printed elsewhere, usually in the answer key: remove this region and draw the answer with the Solution tool.';
    case 'outline-duplicate-id':
      return 'Every section needs an id of its own: change the id of one of them in the Sections list.';
    case 'outline-bad-id':
      return 'An id is 1 to 60 letters, digits, "." "_" or "-", starting with a letter or digit.';
    default:
      return issue.fix;
  }
}
