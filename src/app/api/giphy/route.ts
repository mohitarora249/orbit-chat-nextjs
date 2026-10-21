import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { isGifUrl } from "@/lib/links";
import { jsonError, routeError } from "@/lib/http";
import type { Gif } from "@/lib/types";

export const dynamic = "force-dynamic";

const RESULTS = 25;
const TIMEOUT_MS = 5000;

const giphyResponse = z.object({
  data: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    images: z.object({ fixed_height: z.object({ width: z.coerce.number(), height: z.coerce.number() }) })
  }))
});

// GIF search for /giphy, proxied so the API key stays on the server. Results are the 200px-tall renditions,
// at their canonical URL (built from the id, without GIPHY's tracking parameters), which is what gets posted.
export async function GET(request: NextRequest) {
  try {
    const { error } = await requireUser(request);
    if (error) return error;
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return jsonError("GIFs aren't set up on this server. Add GIPHY_API_KEY to enable /giphy.", 503);
    const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 50);
    if (!query) return jsonError("Add what to search for, like /giphy high five.", 400);
    const params = new URLSearchParams({ api_key: apiKey, q: query, limit: String(RESULTS), rating: process.env.GIPHY_RATING || "pg", lang: "en" });
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!response.ok) return jsonError("GIPHY is unavailable right now. Try again in a moment.", 502);
    const { data } = giphyResponse.parse(await response.json());
    const gifs: Gif[] = data.flatMap(item => {
      const { width, height } = item.images.fixed_height;
      const url = `https://media.giphy.com/media/${item.id}/200.gif`;
      return isGifUrl(url) ? [{ id: item.id, title: item.title || query, url, width, height }] : [];
    });
    return NextResponse.json({ gifs });
  } catch (error) {
    return routeError("GET /api/giphy", error, "Could not search GIFs.");
  }
}
