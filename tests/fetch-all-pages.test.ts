import { describe, expect, it } from "vitest";
import { API_PAGE_SIZE, fetchAllPages } from "@/lib/supabase/fetch-all-pages";

/** A fake API holding `total` rows that, like Supabase, answers a range request with at most one page. */
function fakeApi(total: number) {
  const requests: Array<[number, number]> = [];
  const rows = Array.from({ length: total }, (_, i) => i);
  const fetchPage = async (from: number, to: number) => {
    requests.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { fetchPage, requests };
}

describe("fetchAllPages", () => {
  it("returns a short result from one request", async () => {
    const api = fakeApi(10);
    expect(await fetchAllPages(api.fetchPage)).toHaveLength(10);
    expect(api.requests).toEqual([[0, API_PAGE_SIZE - 1]]);
  });

  it("keeps going past the 1000-row cap, in order, with nothing dropped or doubled", async () => {
    const api = fakeApi(2345);
    const rows = await fetchAllPages(api.fetchPage);
    expect(rows).toEqual(Array.from({ length: 2345 }, (_, i) => i));
    expect(api.requests).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("asks once more when the rows end exactly on a page boundary", async () => {
    // A full page can't tell "that was everything" from "there's more".
    const api = fakeApi(2000);
    expect(await fetchAllPages(api.fetchPage)).toHaveLength(2000);
    expect(api.requests).toHaveLength(3);
  });

  it("treats a null page as empty", async () => {
    expect(await fetchAllPages(async () => ({ data: null, error: null }))).toEqual([]);
  });

  it("throws the API's error rather than returning the rows it got so far", async () => {
    const failure = new Error("boom");
    let calls = 0;
    const fetchPage = async (from: number, to: number) => {
      calls++;
      if (calls === 2) return { data: null, error: failure };
      return { data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null };
    };
    await expect(fetchAllPages(fetchPage)).rejects.toBe(failure);
  });
});
