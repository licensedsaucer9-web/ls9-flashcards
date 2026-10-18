# Design collaboration with Penpot

We use Penpot to sketch the existing app, explore alternatives, and discuss
changes before implementing them. Editable screens give us a shared visual
reference for spacing, hierarchy, wording, and controls. This worked well for
the compact Review layout, including the tier and word-type rows and custom
session-size popup.

Penpot is an exploratory design workspace. The repository's implementation,
tests, and current architecture documentation describe the shipped app and
remain the source of truth. A sketch can contain proposals, example data, or
an illustrative interaction. It may also lag behind the app. There is no
automatic synchronization between Penpot and the code.

## How we work

1. Inspect the current app and relevant code before sketching. Preserve the
   existing product behavior as the starting point.
2. Recreate the relevant screen in Penpot using editable text, shapes, and
   layouts. Simple sketches are sufficient; use screenshots and CSS as
   references, and clearly identify example counts or placeholder data.
3. Explore changes together. Keep comparison versions when useful, and show
   additional states such as an open popup or selected filter. A prototype
   may demonstrate a sample interaction without implementing every outcome.
4. Implement the agreed change in the existing app. Work out persistence,
   accessibility, responsive behavior, and sync requirements in the code.
5. Check the actual app at relevant sizes and run the checks appropriate to
   the change. Record implemented behavior in the repository; update sketches
   when useful for the next discussion.

For Penpot MCP work, confirm the connection and active file/page before editing.
Keep design exploration focused on the screen or flow under discussion. Design
edits, implementation, and production publication are separate steps in the
normal development workflow.
