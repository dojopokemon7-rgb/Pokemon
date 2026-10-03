import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F-#8 — collection-scope end-to-end wiring (RED phase).
 *
 * Pins that the want-list GET route maps its ?collectionId query-string into
 * the right `listWantList` options:
 *   - ?collectionId=<id>        → { collectionId: "<id>" }
 *   - ?collectionId=__account__ → { collectionId: null }
 *   - absent                    → no collectionId key (all scopes)
 * Mocks the service + auth guard; asserts the options object passed through.
 */

const serviceMock = vi.hoisted(() => ({
  listWantList: vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[])),
  addWantListItem: vi.fn(),
}));
vi.mock("@/lib/services/want-list.service", () => serviceMock);

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

import { GET as wantListGET } from "@/app/api/want-list/route";

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.listWantList.mockResolvedValue([]);
});

describe("GET /api/want-list — collectionId query mapping", () => {
  it("?collectionId=<id> → listWantList with that collectionId", async () => {
    await wantListGET(new Request("http://localhost/api/want-list?intent=BUY&collectionId=col_9"));
    expect(serviceMock.listWantList).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ intent: "BUY", collectionId: "col_9" })
    );
  });

  it("?collectionId=__account__ → listWantList with collectionId:null", async () => {
    await wantListGET(new Request("http://localhost/api/want-list?collectionId=__account__"));
    const opts = serviceMock.listWantList.mock.calls[0][1] as { collectionId?: unknown };
    expect(opts.collectionId).toBeNull();
  });

  it("absent collectionId → no collectionId key (all scopes)", async () => {
    await wantListGET(new Request("http://localhost/api/want-list?intent=SELL"));
    const opts = serviceMock.listWantList.mock.calls[0][1] as { intent?: unknown };
    expect("collectionId" in opts).toBe(false);
    expect(opts.intent).toBe("SELL");
  });
});
