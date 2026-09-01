/**
 * ArrowRight — the ONE arrow icon used on every primary CTA in the app.
 *
 * Ported verbatim from the design system's `ico.arrow` in
 * dojo-prototype/app.js:
 *
 *   <svg width="24" height="10" viewBox="0 0 24 10">
 *     <path d="M0 5 H22 M17 1 L22 5 L17 9"
 *           stroke="#0D0D0D" stroke-width="1.5"
 *           fill="none" stroke-linecap="square"/>
 *   </svg>
 *
 * Every primary button in the app (SIGN IN, CREATE ACCOUNT, CREATE
 * PROFILE, SEND RESET LINK, RESET PASSWORD, and any future CTA) MUST
 * import this component. Do not inline the SVG anywhere. If the client
 * asks to tweak the arrow, this is the single file to change.
 *
 * `stroke` uses `currentColor`, so the arrow adopts whatever color the
 * containing button sets. Inside `.dojo-btn-primary` that resolves to
 * the button's `color: #0D0D0D` (black on gold). Callers don't need to
 * pass a color — that's the whole point of using a shared component.
 */

export function ArrowRight() {
  return (
    <svg
      width="24"
      height="10"
      viewBox="0 0 24 10"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M0 5 H22 M17 1 L22 5 L17 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      />
    </svg>
  );
}
