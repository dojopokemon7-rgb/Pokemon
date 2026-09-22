import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Trivial "app renders" smoke test — proves the jsdom + React Testing
 * Library harness works end to end (render → query the DOM).
 */
function Hello() {
  return <h1>TCG Collection</h1>;
}

describe("app renders", () => {
  it("mounts a component and finds its text", () => {
    render(<Hello />);
    expect(screen.getByRole("heading", { name: "TCG Collection" })).toBeInTheDocument();
  });
});
