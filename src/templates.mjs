// Prompt templates for dsh workers and the workspace AGENTS.md. Workers run
// unattended, so every template states the deliverable files explicitly.

export const TEMPLATES = ['raw', 'research', 'materials']
export const DEPTHS = ['quick', 'standard', 'deep']
export const MATERIAL_KINDS = {
  screenshots: 'screenshots of blogs, websites and articles',
  scroll: 'scroll videos (screen recordings) of blog posts and websites',
  articles: 'news articles with a screenshot of the headline',
  'stock-video': 'stock footage clips from free sources',
  'stock-photo': 'stock photos from free sources',
}

const today = () => new Date().toISOString().slice(0, 10)

const WORKER_PREAMBLE = `You are an unattended dsh worker. Another agent started you through dsh-cli and will only read your files and your final answer. Nobody is in the loop: do not ask questions, make sensible assumptions and write them down, look for alternatives instead of giving up. All files go into your working folder. Write in the language of the task.`

/**
 * Header naming the job's output folder. Web batches share one Workspace
 * directory as session cwd, so each worker needs its own folder spelled out.
 */
export function workdirHeader(outDir) {
  return `Working folder for this task: ${outDir}
Put every file there and nowhere else. Run shell commands as \`cd "${outDir}" && ...\` or use absolute paths below it. Other folders in the workspace belong to parallel jobs; do not touch them.

`
}

const DEPTH_RULES = {
  quick: 'Depth quick: 3 to 5 good sources, focus on what matters, finish fast.',
  standard: 'Depth standard: 6 to 10 sources, check numbers and key claims against at least two sources.',
  deep: 'Depth deep: 10 or more sources, prefer primary sources, name counter positions and uncertainty explicitly.',
}

export function researchPrompt(question, { depth = 'standard', extra } = {}) {
  return `${WORKER_PREAMBLE}

## Research question
${question.trim()}

## Method
- Today is ${today()}. Prefer current information and note the date of every source.
- Use the best search and fetch tools you have (for example firecrawl or Brave Search MCP tools if present, context7 for library docs); built-in web_search and web_fetch are the fallback.
- ${DEPTH_RULES[depth] ?? DEPTH_RULES.standard}
- Never invent content. Mark anything you could not verify as open.
${extra ? `- Additional instruction: ${extra.trim()}\n` : ''}
## Required output (files in your working folder)
1. \`report.md\`: title, summary (3 to 5 sentences), key facts as a list with source references like [1], details, open questions, numbered source list with URL, title, publisher, date.
2. \`sources.json\`: JSON array of objects {"url", "title", "publisher", "date", "relevance" (1 to 5), "notes"}.

## Final answer
Only the summary and the 3 most important facts, at most 150 words. The full report lives in report.md.`
}

const KIND_RULES = {
  screenshots: `Find relevant blog posts, articles and websites on the topic and take screenshots.
- Tool: \`dsho capture shot <url> -o screenshots/<nn>-<short-name>.png\` (1440x900 viewport, cookie banners and overlays are removed automatically). Whole page: \`--full\`; one element: \`--selector "<css>"\`.
- Check every screenshot (open or view it): no cookie banner, no paywall overlay, readable content. Otherwise capture again or replace it.`,
  scroll: `Create scroll videos (smooth scrolling) of relevant blog posts and websites.
- Tool: \`dsho capture scroll <url> -o scroll/<nn>-<short-name>.mp4 --duration 12\` (1920x1080, H.264, cookie banners removed automatically).
- Check every video with ffprobe (duration, resolution) and one still (\`ffmpeg -ss 3 -i file.mp4 -frames:v 1 check.png\`). Record again when a banner or a blank frame shows.`,
  articles: `Find current news articles on the topic, local and international.
- For each article: a headline screenshot with \`dsho capture shot <url> -o articles/<nn>-<outlet>.png\` (viewport, not the full page) and an excerpt in articles/<nn>-<outlet>.md (headline, outlet, date, author, 3 to 5 key points, URL).
- Paywalled articles only when headline and teaser are visible.`,
  'stock-video': `Find matching stock footage clips from free sources (Pexels, Pixabay, Coverr, Mixkit, Videvo with a free licence).
- Download them as MP4, preferably 1920x1080 or 4K, with curl from the direct file URL or with yt-dlp. Save them as stock-video/<nn>-<short-name>.mp4.
- Check every file with ffprobe (duration, resolution, codec). Record the licence exactly.`,
  'stock-photo': `Find matching stock photos from free sources (Unsplash, Pexels, Pixabay).
- Download them in high resolution as stock-photo/<nn>-<short-name>.jpg.
- Record photographer, source and licence exactly.`,
}

export function materialsPrompt(brief, { kind, urls = [], count = 6 } = {}) {
  const rules = KIND_RULES[kind]
  if (!rules) throw new Error(`Unknown material kind ${kind}`)
  return `${WORKER_PREAMBLE}

## Task: gather material (${MATERIAL_KINDS[kind]})
Topic and brief:
${brief.trim()}

## Method
- Today is ${today()}.
- Goal: about ${count} high quality results that fit the topic. Quality over quantity.
- Find sources with your search tools (web, news, images, videos).
${urls.length ? `- Process these URLs first, they are mandatory:\n${urls.map((u) => `  - ${u}`).join('\n')}\n` : ''}- ${rules.split('\n').join('\n')}
- File names: two-digit running number plus a short descriptive name, lowercase letters, digits and hyphens only.

## Required output (files in your working folder)
1. The material files in the subfolder \`${kind}/\`.
2. \`manifest.json\`: JSON array, one object per file: {"file" (relative path), "kind": "${kind}", "source_url", "title", "publisher", "author", "license", "date", "notes"}.
3. \`README.md\`: a short overview table (file, content, source, licence).

## Final answer
Number of files, one line per file (file name: content), problems if any. At most 200 words.`
}

export function workspaceAgentsMd({ name, kind = 'general', description }) {
  return `# dsh workspace: ${name}

${description ? description.trim() + '\n\n' : ''}This folder is a workspace for dsh workers started through dsh-cli (\`dsho\`).
Kind: ${kind}. Created ${today()}.

## Conventions for workers
- Work only in your working folder (named at the top of your task) and below it. Leave other job folders alone.
- Deliver results as files; the final answer is only a summary.
- Research: \`report.md\` plus \`sources.json\`.
- Material: files in the subfolder of the material kind plus \`manifest.json\` and \`README.md\`.
- Take screenshots and scroll videos with \`dsho capture shot\` and \`dsho capture scroll\`.
- Always record licences and sources exactly.

## Layout
- \`<batch>/<nn-job>/\`: one folder per job of a batch
- \`<batch>/INDEX.md\`: overview, written by \`dsho collect <batch>\`
`
}
