import type { Nodes, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parser = unified().use(remarkParse).use(remarkGfm);

function text(node: Nodes): string {
    if (node.type === 'text' || node.type === 'inlineCode') return node.value;
    return 'children' in node ? node.children.map(text).join('') : '';
}

function short(value: string, limit = 180): string {
    const line = value.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
    return line.length > limit ? line.slice(0, limit - 1).trimEnd() + '…' : line;
}

function section(nodes: RootContent[], name: string): RootContent[] {
    const start = nodes.findIndex((n) => n.type === 'heading' && n.depth === 2 && text(n).toLowerCase().replace(/:$/, '') === name);
    if (start < 0) return [];
    let end = nodes.findIndex((n, i) => i > start && n.type === 'heading' && n.depth <= 2);
    if (end < 0) end = nodes.length;
    return nodes.slice(start + 1, end);
}

function overview(nodes: RootContent[]): string | undefined {
    for (const name of ['summary', 'objective']) {
        const paragraph = section(nodes, name).find((n) => n.type === 'paragraph');
        if (paragraph) return short(text(paragraph).replace(/\s+/g, ' '), 350);
    }
}

function empty(value: string): boolean {
    return /^(?:none\b|no (?:actionable |worthwhile |maintenance )?(?:findings|changes|improvements|investigations)\b|nothing (?:actionable|worthwhile)\b)/i.test(value.trim());
}

// Read titles only: descriptions, nested evidence, code and coverage never reach Telegram.
function entries(nodes: RootContent[]): string[] {
    const headings = nodes.filter((n) => n.type === 'heading');
    if (headings.length) {
        const identified = headings.filter((h) => /\bR\d+\.\d+-[a-z0-9.]+-[a-z]?\d+\b/i.test(text(h)));
        const candidates = identified.length ? identified : headings;
        const depth = Math.min(...candidates.map((h) => h.depth));
        return candidates.filter((h) => h.depth === depth).map((h) => short(text(h))).filter((title) => !empty(title));
    }
    const result: string[] = [];
    for (const node of nodes) {
        if (node.type === 'list') {
            for (const item of node.children) {
                const first = item.children.find((n) => n.type === 'paragraph');
                if (first) result.push(short(text(first)));
            }
        } else if (node.type === 'table') {
            const columns = node.children[0]?.children.map((cell) => text(cell).toLowerCase()) ?? [];
            const title = columns.findIndex((c) => /^(title|summary|finding)$/.test(c));
            const id = columns.findIndex((c) => /^(id|key|finding id)$/.test(c));
            if (title < 0) continue;
            for (const row of node.children.slice(1)) {
                const cells = row.children.map(text);
                result.push(short([id >= 0 ? cells[id] : '', cells[title]].filter(Boolean).join(' — ')));
            }
        } else if (node.type === 'paragraph' && /^R\d+\.\d+-/.test(text(node))) {
            result.push(short(text(node)));
        }
    }
    return result.filter((title) => !empty(title));
}

function count(nodes: RootContent[], titles: string[]): number | undefined {
    if (titles.length) return titles.length;
    const body = nodes.map(text).join(' ').trim();
    return !body || empty(body) ? 0 : undefined;
}

export function maintenanceCampaignSummary(document: string, chunks: { id: string; title: string }[]): string {
    const nodes = parser.parse(document).children;
    const title = nodes.find((n) => n.type === 'heading' && n.depth === 1);
    const ids = chunks.map((c) => c.id).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]));
    return [title ? short(text(title)) : 'Campaign prepared',
        `${chunks.length} chunks · range ${ids[0]}${ids.length > 1 ? `-${ids.at(-1)}` : ''}`,
        overview(nodes), '',
        ...chunks.map((chunk) => `- ${chunk.id} ${short(chunk.title)}`),
    ].filter((line) => line !== undefined).join('\n');
}

export function maintenanceReportSummary(report: string): string {
    const nodes = parser.parse(report).children;
    const findings = section(nodes, 'findings');
    const investigations = section(nodes, 'investigations');
    const titles = entries(findings);
    const total = count(findings, titles);
    const investigationsTotal = count(investigations, entries(investigations));
    return [
        `Review complete · ${total === undefined ? 'findings in full report' : `${total} finding${total === 1 ? '' : 's'}`}` +
            `${investigationsTotal === undefined ? ' · investigations in full report' : ` · ${investigationsTotal} investigation${investigationsTotal === 1 ? '' : 's'}`}`,
        overview(nodes), '',
        ...(titles.length ? titles.map((title) => `- ${title}`) : [total === 0 ? 'No actionable findings.' : 'See the full report for findings.']),
    ].filter((line) => line !== undefined).join('\n');
}
