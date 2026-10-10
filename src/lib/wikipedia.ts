import fs from "node:fs";
import path from "node:path";

/**
 * Research from Wikipedia and Wikimedia Commons.
 *
 * A long video used to be written from what the model remembered, which is why
 * it named almost nobody and quoted nobody: it was told to leave out anything
 * it was unsure of. An accident article is the investigation report retold with
 * its references attached - names, times, the cockpit recording - so the script
 * is written FROM it, and the pictures are the ones that article carries, each
 * with a licence that says whether it can be shown.
 */

const API = "https://en.wikipedia.org/w/api.php";
// Wikimedia asks for a descriptive agent and throttles anonymous ones.
const AGENT = "tiktok-youtube-automation/0.1 (video research; github.com/MumeDoktor/tiktok-and-youtube-automatization)";

async function api<T>(params: Record<string, string>, host = API): Promise<T> {
  const url = `${host}?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params })}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": AGENT } });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3) throw new Error(`Wikipedia answered ${res.status} for ${params.action}/${params.prop ?? params.list ?? ""}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

export type Article = { title: string; url: string; text: string };

/** The best-matching article title for a phrase, or null. */
export async function findArticle(query: string): Promise<string | null> {
  const data = await api<{ query?: { search?: Array<{ title: string }> } }>({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
  });
  return data.query?.search?.[0]?.title ?? null;
}

/** An article as plain text, with the sections that are only lists of links cut off. */
export async function readArticle(title: string): Promise<Article | null> {
  const data = await api<{ query?: { pages?: Array<{ title: string; extract?: string; missing?: boolean }> } }>({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    titles: title,
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  const text = page.extract.split(/\n==\s*(See also|References|External links|Notes|Further reading)\s*==/)[0].trim();
  return {
    title: page.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    text,
  };
}

export type Picture = {
  /** Commons file name, e.g. "File:Aloha Airlines Flight 243 fuselage.png". */
  name: string;
  /** The article it was found on. */
  from: string;
  description: string;
  credit: string;
  license: string;
  width: number;
  height: number;
  /** A 1920-wide rendition. */
  url: string;
  /** Set once downloaded. */
  file?: string;
};

const strip = (html: string | undefined) =>
  (html ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

/**
 * Licences a published, monetized video can use: public domain, or Creative
 * Commons with attribution (the credit goes in the description). "Fair use"
 * and non-commercial files are left out - Wikipedia may show them; we may not.
 */
const usable = (license: string) => /^(public domain|pd\b|cc0|cc by(-sa)?[ -]\d)/i.test(license.trim());

type Info = {
  thumburl?: string;
  url?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: Record<string, { value?: string }>;
};
type Pages = { query?: { pages?: Array<{ title: string; index?: number; imageinfo?: Info[] }> } };

const IMAGE_PROPS = { prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1920" };

function toPictures(data: Pages, from: string): Picture[] {
  const out: Picture[] = [];
  const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    if (!/^image\/(jpeg|png)$/.test(info.mime ?? "")) continue;
    // Icons, flags and logos are in every article and are not pictures.
    if ((info.width ?? 0) < 700 || (info.height ?? 0) < 450) continue;
    if (/(logo|icon|flag|locator|symbol|pictogram|commons-logo|edit-clear)/i.test(page.title)) continue;
    const meta = info.extmetadata ?? {};
    const license = strip(meta.LicenseShortName?.value);
    if (!usable(license)) continue;
    const description = (strip(meta.ImageDescription?.value) || page.title.replace(/^File:|\.\w+$/g, "")).slice(0, 300);
    // The warning-sign drawing every accident article carries in its infobox.
    if (/^sign based on/i.test(description)) continue;
    const taken = strip(meta.DateTimeOriginal?.value).match(/(19|20)\d\d/)?.[0];
    out.push({
      name: page.title,
      from,
      description: taken && !description.includes(taken) ? `${description} [taken ${taken}]` : description,
      credit: (strip(meta.Artist?.value) || strip(meta.Credit?.value) || "Wikimedia Commons").slice(0, 120),
      license,
      width: info.width ?? 0,
      height: info.height ?? 0,
      url: info.thumburl ?? info.url,
    });
  }
  return out;
}

/** The photographs an article carries, with what each shows and how it is licensed. */
export async function articlePictures(title: string): Promise<Picture[]> {
  const data = await api<Pages>({
    action: "query",
    generator: "images",
    gimlimit: "60",
    redirects: "1",
    titles: title,
    ...IMAGE_PROPS,
  });
  return toPictures(data, title);
}

/**
 * Photographs from Wikimedia Commons by search phrase.
 *
 * An accident's own article usually carries two or three pictures. Commons
 * holds hundreds of the same airline's aircraft of the same type in the same
 * years - the nearest thing to footage of the flight that exists.
 */
export async function commonsPictures(search: string, limit = 8): Promise<Picture[]> {
  const data = await api<Pages>(
    {
      action: "query",
      generator: "search",
      gsrnamespace: "6",
      gsrsearch: `${search} filetype:bitmap`,
      gsrlimit: String(Math.min(30, limit * 3)),
      ...IMAGE_PROPS,
    },
    "https://commons.wikimedia.org/w/api.php",
  );
  return toPictures(data, `Commons: ${search}`).slice(0, limit);
}

/** Downloads the pictures into a folder and returns the ones that arrived. */
export async function downloadPictures(pictures: Picture[], dir: string): Promise<Picture[]> {
  fs.mkdirSync(dir, { recursive: true });
  const got: Picture[] = [];
  for (let i = 0; i < pictures.length; i++) {
    const p = pictures[i];
    const ext = /\.png(\?|$)/i.test(p.url) ? ".png" : ".jpg";
    const file = path.join(dir, `p${String(i).padStart(2, "0")}${ext}`);
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < 5000) {
        const res = await fetch(p.url, { headers: { "user-agent": AGENT } });
        if (!res.ok) continue;
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        // Commons throttles a burst of image requests from one address.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (fs.statSync(file).size >= 5000) got.push({ ...p, file });
    } catch {
      // One missing picture is not worth losing the video for.
    }
  }
  return got;
}
