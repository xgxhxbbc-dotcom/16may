import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { X, Download, BookOpen, ChevronDown, ChevronUp, Volume2, GitCompare, Maximize2, Minimize2, CheckCircle2, Shuffle, MapPin, ChevronsRight, Lock, Crown } from 'lucide-react';
import { ChunkedNotesReader } from './ChunkedNotesReader';
import type { NoteSearchResult, PageBlob } from '../utils/noteSearcher';
import { loadAllPagesFromKey } from '../utils/noteSearcher';
import { getCompreBookNotes } from '../firebase';
import type { CompreNote } from '../firebase';

// ── Daily Limit Helpers ──
const FREE_DAILY_LIMIT = 3;
const DAILY_KEY = 'compare_daily';

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyUsage(): { date: string; count: number } {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === getTodayStr()) return parsed;
    }
  } catch {}
  return { date: getTodayStr(), count: 0 };
}

function incrementDailyUsage(): number {
  const usage = getDailyUsage();
  const next = { date: getTodayStr(), count: usage.count + 1 };
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(next)); } catch {}
  return next.count;
}

interface Props {
  hits: NoteSearchResult[];
  query: string;
  onClose: () => void;
  user?: { subscriptionLevel?: string; isPremium?: boolean };
  settings?: Record<string, any>;
}

type Mode = 'topic-compare' | 'book-by-book' | 'read-all' | 'book-notes';

// ── Helpers ──

function normalizeSentence(s: string): string {
  return s.toLowerCase().replace(/[^\u0900-\u097fa-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function getSignificantWords(s: string): string[] {
  return normalizeSentence(s).split(' ').filter(w => w.length >= 3);
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(getSignificantWords(a));
  const wb = new Set(getSignificantWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  wa.forEach(w => { if (wb.has(w)) common++; });
  return common / Math.min(wa.size, wb.size);
}

function splitIntoPoints(text: string): string[] {
  return text
    .split(/[\n।]+/)
    .map(s => s.replace(/^[-•●▪\*\d]+[\.\)]\s*/, '').trim())
    .filter(s => s.length >= 10);
}

// ── Topic Boundary Extraction ──

interface TopicSection {
  topicTitle: string;   // The heading line that matched the query
  topicEnd: string;     // First line of the NEXT topic (so reader knows where it ends)
  sectionText: string;  // All lines from heading to next heading
}

// ── Line classifier ──

type LineKind =
  | { type: 'markdown'; level: number; text: string }  // ## Title  → level 2
  | { type: 'numbered'; text: string }                  // 1. Babar
  | { type: 'emoji-heading'; text: string }             // 🏁 Title
  | { type: 'end-marker'; text: string }                // THE END / SAMPANN / 🛑
  | { type: 'separator' }                               // --- / ===
  | { type: 'content'; text: string };

const END_WORDS = [
  'the end', 'topic closed', 'topic finished', 'sampann', 'samaapt',
  'समाप्त', 'सम्पन्न', 'yahan khatam', 'chapter end', 'end of topic',
  'topic wrap', 'topic complete', '[ topic closed ]', '🏁', '🔚', '🛑',
  'status: 100%',
];

const END_EMOJI_RX = /[🏁🔚🛑]/u;

function classifyLine(raw: string): LineKind {
  const line = raw.trim();

  // Markdown heading: ## Title
  const mdMatch = line.match(/^(#{1,6})\s+(.+)/);
  if (mdMatch) return { type: 'markdown', level: mdMatch[1].length, text: mdMatch[2].trim() };

  // Hard separator
  if (/^([=\-─━*]{3,})\s*$/.test(line)) return { type: 'separator' };

  const lower = line.toLowerCase();

  // End marker (must check before emoji-heading so 🏁 lines are caught here)
  if (END_WORDS.some(w => lower.includes(w)) || END_EMOJI_RX.test(line)) {
    return { type: 'end-marker', text: line };
  }

  // Emoji-heading: line starts with emoji, is short
  if (/^\p{Emoji}/u.test(line) && line.length < 100) {
    return { type: 'emoji-heading', text: line };
  }

  // Numbered heading: "1. Title" or "1) Title" — NOT a list item inside content
  const numMatch = line.match(/^(\d{1,2})[\.\)]\s+(.+)/);
  if (numMatch && numMatch[2].length < 80) return { type: 'numbered', text: numMatch[2].trim() };

  return { type: 'content', text: line };
}

/** Assign a comparable "rank" to a heading so we can find the NEXT heading of equal/higher rank. */
function headingRank(kind: LineKind): number {
  if (kind.type === 'markdown') return kind.level;   // 1 = #, 2 = ##, 3 = ###
  if (kind.type === 'emoji-heading') return 2;        // treat like ##
  if (kind.type === 'numbered') return 2;             // treat like ##
  return 99;
}

/**
 * Smart topic-boundary extraction.
 *
 * Understands:
 *   - Markdown headings  (##, ###, ####)
 *   - Emoji headings     (🏁 Title, ✅ Phase 1 …)
 *   - Numbered sections  (1. Babar, 2. Humayun)
 *   - Separator lines    (---, ===, ═══)
 *   - End markers        (THE END, SAMPANN, समाप्त, 🛑, 🔚, [TOPIC CLOSED] …)
 */
function extractTopicSection(fullText: string, queryWords: string[]): TopicSection | null {
  const effectiveWords = queryWords.filter(w => w.length >= 2);
  if (effectiveWords.length === 0) return null;

  const rawLines = fullText.split('\n').filter(l => l.trim().length > 0);
  if (rawLines.length < 2) return null;

  // Classify every line
  const classified = rawLines.map((raw, idx) => ({ idx, raw: raw.trim(), kind: classifyLine(raw) }));

  const hasAlpha = (s: string) => /[\u0900-\u097fa-zA-Z]/.test(s);

  const scoreLine = (raw: string): number => {
    const lower = raw.toLowerCase();
    return effectiveWords.filter(w => lower.includes(w.toLowerCase())).length;
  };

  // ── Find the best start heading that contains query words ──
  const headingTypes: LineKind['type'][] = ['markdown', 'emoji-heading', 'numbered'];

  // Also allow plain short lines (fallback)
  const isShortPlainHeading = (raw: string, kind: LineKind) =>
    kind.type === 'content' && hasAlpha(raw) && raw.length < 70 &&
    !raw.endsWith(',') && !raw.endsWith(';');

  const candidates = classified
    .map(c => {
      const score = scoreLine(c.raw);
      const isHeading = headingTypes.includes(c.kind.type) || isShortPlainHeading(c.raw, c.kind);
      return { ...c, score, isHeading };
    })
    .filter(c => c.score > 0 && c.isHeading)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Among equal score: prefer explicit headings over plain short lines
      const aIsExplicit = headingTypes.includes(a.kind.type) ? 0 : 1;
      const bIsExplicit = headingTypes.includes(b.kind.type) ? 0 : 1;
      if (aIsExplicit !== bIsExplicit) return aIsExplicit - bIsExplicit;
      return a.raw.length - b.raw.length; // shorter = more heading-like
    });

  if (candidates.length === 0) return null;

  const startEntry = candidates[0];
  const startIdx = startEntry.idx;
  const topicTitle = startEntry.raw;
  const startRank = headingRank(startEntry.kind);

  // ── Find topic end: next heading of same/higher rank, separator, or end-marker ──
  let endIdx = classified.length;
  for (let i = startIdx + 1; i < classified.length; i++) {
    const { kind, raw } = classified[i];

    // End marker → hard stop
    if (kind.type === 'end-marker') {
      // Include the end marker itself in the section so it's visible
      endIdx = i + 1;
      break;
    }

    // Separator → hard stop
    if (kind.type === 'separator') { endIdx = i; break; }

    // Another heading of same or higher rank (lower level number) that doesn't match query
    if (headingTypes.includes(kind.type)) {
      const rank = headingRank(kind);
      if (rank <= startRank && scoreLine(raw) === 0 && i > startIdx + 2) {
        endIdx = i; break;
      }
    }

    // Plain short line that looks like a new section heading, no query words
    if (isShortPlainHeading(raw, kind) && scoreLine(raw) === 0 && hasAlpha(raw) && i > startIdx + 3) {
      endIdx = i; break;
    }
  }

  const sectionLines = classified.slice(startIdx, endIdx).map(c => c.raw);
  const sectionText = sectionLines.join('\n');

  // The line just after our section = topicEnd (what comes next)
  const nextEntry = classified[endIdx];
  const topicEnd = nextEntry ? nextEntry.raw : '';

  if (sectionLines.length < 2) return null;
  return { topicTitle, topicEnd, sectionText };
}

// ── Compare Engine ──

interface BookContent {
  bookName: string;
  pageNo?: string;
  text: string;
  topicTitle?: string;
  topicEnd?: string;
}

interface TopicCompareResult {
  common: string[];
  extra: {
    bookName: string;
    pageNo?: string;
    points: string[];
    topicTitle?: string;
    topicEnd?: string;
  }[];
}

function computeTopicComparison(bookContents: BookContent[]): TopicCompareResult {
  if (bookContents.length === 0) return { common: [], extra: [] };

  const bookPoints = bookContents.map(bc => ({
    bookName: bc.bookName,
    pageNo: bc.pageNo,
    topicTitle: bc.topicTitle,
    topicEnd: bc.topicEnd,
    points: splitIntoPoints(bc.text),
  }));

  const common: string[] = [];
  const usedCommon = new Set<string>();
  const extraPerBook = bookPoints.map(b => ({
    bookName: b.bookName,
    pageNo: b.pageNo,
    topicTitle: b.topicTitle,
    topicEnd: b.topicEnd,
    points: [] as string[],
  }));

  bookPoints.forEach((book, bi) => {
    book.points.forEach(point => {
      let matchedInOther = false;
      for (let other = 0; other < bookPoints.length; other++) {
        if (other === bi) continue;
        if (bookPoints[other].points.some(p => wordOverlap(point, p) >= 0.35)) {
          matchedInOther = true;
          break;
        }
      }
      if (matchedInOther) {
        const alreadyIn = common.some(c => wordOverlap(point, c) >= 0.65);
        const norm = normalizeSentence(point);
        if (!alreadyIn && !usedCommon.has(norm)) {
          common.push(point);
          usedCommon.add(norm);
        }
      } else {
        extraPerBook[bi].points.push(point);
      }
    });
  });

  return { common, extra: extraPerBook };
}

// ── Compre Book Notes — standard books list ──
const CN_BOOKS_CV = [
  { id: 'lucent',              label: '📘 Lucent GK' },
  { id: 'sarSangrah',          label: '📒 Sar Sangrah' },
  { id: 'speedyScience',       label: '🔬 Speedy Science' },
  { id: 'speedySocialScience', label: '🌍 Speedy Social Sci' },
];

// ── Component ──

export const CompareView: React.FC<Props> = ({ hits, query, onClose, user, settings }) => {
  const isSingleBook = hits.length <= 1;
  const [mode, setMode] = useState<Mode>(isSingleBook ? 'book-by-book' : 'topic-compare');
  const [expandedBooks, setExpandedBooks] = useState<Set<number>>(new Set(hits.map((_, i) => i)));

  const [topicResult, setTopicResult] = useState<TopicCompareResult | null>(null);
  const [extractedSections, setExtractedSections] = useState<BookContent[]>([]);
  const [topicLoading, setTopicLoading] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [activeTopicQuery, setActiveTopicQuery] = useState<string>(query);
  const [limitReached, setLimitReached] = useState(false);
  const [dailyUsedCount, setDailyUsedCount] = useState(() => getDailyUsage().count);

  const isUltra = user?.subscriptionLevel === 'ULTRA' || (user as any)?.subscriptionTier === 'LIFETIME';
  const remainingToday = Math.max(0, FREE_DAILY_LIMIT - dailyUsedCount);

  const [cnAllNotes, setCnAllNotes] = useState<{bookId: string; bookLabel: string; note: CompreNote}[] | null>(null);
  const [cnNotesLoading, setCnNotesLoading] = useState(false);
  const [cnActiveTopic, setCnActiveTopic] = useState<string | null>(null);

  const [floatPos, setFloatPos] = useState({ x: window.innerWidth - 72, y: Math.floor(window.innerHeight * 0.55) });
  const floatDragging = useRef(false);
  const floatMoved = useRef(false);
  const floatStart = useRef({ px: 0, py: 0, bx: 0, by: 0 });

  // Group hits by bookName (deduplicate)
  const books = useMemo(() => {
    const seen = new Set<string>();
    return hits.filter(h => {
      const key = h.bookName || h.subjectName;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [hits]);

  const combinedContent = useMemo(() => {
    return books.map(h => {
      const bookName = h.bookName || h.subjectName;
      return `${bookName}:\n${(h.noteContent || '').trim()}`;
    }).join('\n\n');
  }, [books]);

  // Extract 📌 topic headings from all books' full content for topic picker
  const pinTopics = useMemo(() => {
    const topics: string[] = [];
    const seen = new Set<string>();
    books.forEach(book => {
      const content = book.noteFullContent || book.noteContent || '';
      const parts = content.split(/📌\s*/);
      parts.slice(1).forEach(part => {
        const firstLine = part.split('\n')[0]?.trim() || '';
        if (firstLine.length > 2 && firstLine.length < 200 && !seen.has(firstLine)) {
          seen.add(firstLine);
          topics.push(firstLine);
        }
      });
    });
    return topics;
  }, [books]);

  // ── Load topic compare with topic-boundary extraction ──
  const loadTopicCompare = useCallback(async (overrideQuery?: string) => {
    if (!isUltra) {
      const usage = getDailyUsage();
      if (usage.count >= FREE_DAILY_LIMIT) {
        setLimitReached(true);
        setDailyUsedCount(usage.count);
        return;
      }
      const newCount = incrementDailyUsage();
      setDailyUsedCount(newCount);
    }
    setTopicLoading(true);
    setTopicResult(null);
    try {
      const effectiveQuery = overrideQuery ?? activeTopicQuery;
      const words = effectiveQuery.trim().split(/\s+/).filter(w => w.length >= 2);
      const bookContents: BookContent[] = [];

      // Check if ALL hits have the same topicName — if so, use topic-name based match
      const topicNames = books.map(b => b.topicName).filter(Boolean);
      const allSameTopicName = topicNames.length === books.length && new Set(topicNames).size === 1;

      await Promise.all(books.map(async (book) => {
        const bookName = book.bookName || book.subjectName;
        const key = book.storageKey;

        let fullText = '';

        // hw_* and lucent_* are virtual keys — use noteFullContent directly
        if (key.startsWith('hw_') || key.startsWith('lucent_')) {
          fullText = book.noteFullContent || book.noteContent || '';
        } else {
          // Real cached chapter — load all pages and pick best match
          const blobs = await loadAllPagesFromKey(key, words);
          if (blobs.length > 0 && blobs[0].text.length > 10) {
            fullText = blobs[0].text;
          } else {
            fullText = book.noteFullContent || book.noteContent || '';
          }
        }

        if (fullText.length <= 10) return;

        // If this note has an explicit topicName tag, use it to extract the section
        // more precisely (prepend as heading so extractTopicSection finds it)
        if (book.topicName) {
          const topicWords = book.topicName.split(/\s+/).filter(w => w.length >= 2);
          const searchWords = allSameTopicName ? topicWords : words;
          const section = extractTopicSection(fullText, searchWords);
          if (section) {
            bookContents.push({
              bookName,
              pageNo: book.pageNo,
              text: section.sectionText,
              topicTitle: book.topicName,   // Use the admin-tagged topic name as authoritative
              topicEnd: section.topicEnd,
            });
          } else {
            // Full text if section not found — the whole note is about this topic
            bookContents.push({
              bookName,
              pageNo: book.pageNo,
              text: fullText,
              topicTitle: book.topicName,
            });
          }
          return;
        }

        // Standard path: try to extract topic-specific section by query words
        const section = extractTopicSection(fullText, words);

        if (section) {
          bookContents.push({
            bookName,
            pageNo: book.pageNo,
            text: section.sectionText,
            topicTitle: section.topicTitle,
            topicEnd: section.topicEnd,
          });
        } else {
          // Full text fallback
          bookContents.push({ bookName, pageNo: book.pageNo, text: fullText });
        }
      }));

      setExtractedSections(bookContents);
      setTopicResult(computeTopicComparison(bookContents));
    } finally {
      setTopicLoading(false);
    }
  }, [books, activeTopicQuery]);

  useEffect(() => { loadTopicCompare(); }, []);
  useEffect(() => {
    if (mode === 'topic-compare' && !topicResult && !topicLoading) loadTopicCompare();
  }, [mode]);
  useEffect(() => {
    loadTopicCompare(activeTopicQuery);
  }, [activeTopicQuery]);

  const cnTopics = useMemo(() => {
    if (!cnAllNotes) return [];
    const seen = new Set<string>();
    const topics: string[] = [];
    cnAllNotes.forEach(e => {
      const topic = e.note.topicName || `Page ${e.note.pageNumber}`;
      if (!seen.has(topic)) { seen.add(topic); topics.push(topic); }
    });
    return topics;
  }, [cnAllNotes]);

  const cnActiveEntries = useMemo(() => {
    if (!cnAllNotes || !cnActiveTopic) return [];
    return cnAllNotes.filter(e => (e.note.topicName || `Page ${e.note.pageNumber}`) === cnActiveTopic);
  }, [cnAllNotes, cnActiveTopic]);

  const loadCnNotes = useCallback(async () => {
    if (cnAllNotes !== null) return;
    setCnNotesLoading(true);
    try {
      const results: {bookId: string; bookLabel: string; note: CompreNote}[] = [];
      await Promise.all(CN_BOOKS_CV.map(async bt => {
        try {
          const notes = await getCompreBookNotes(bt.id);
          notes.forEach(note => results.push({ bookId: bt.id, bookLabel: bt.label, note }));
        } catch {}
      }));
      results.sort((a, b) => b.note.createdAt.localeCompare(a.note.createdAt));
      setCnAllNotes(results);
    } finally {
      setCnNotesLoading(false);
    }
  }, [cnAllNotes]);

  useEffect(() => {
    if (cnAllNotes && cnTopics.length > 0 && !cnActiveTopic) {
      setCnActiveTopic(cnTopics[0]);
    }
  }, [cnAllNotes, cnTopics, cnActiveTopic]);

  const toggleBook = (idx: number) => {
    setExpandedBooks(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  // ── Floating drag ──
  const onFloatTouchStart = (e: React.TouchEvent) => {
    floatDragging.current = true; floatMoved.current = false;
    floatStart.current = { px: e.touches[0].clientX, py: e.touches[0].clientY, bx: floatPos.x, by: floatPos.y };
  };
  const onFloatTouchMove = (e: React.TouchEvent) => {
    if (!floatDragging.current) return;
    const dx = e.touches[0].clientX - floatStart.current.px;
    const dy = e.touches[0].clientY - floatStart.current.py;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) floatMoved.current = true;
    setFloatPos({ x: Math.max(8, Math.min(window.innerWidth - 68, floatStart.current.bx + dx)), y: Math.max(8, Math.min(window.innerHeight - 68, floatStart.current.by + dy)) });
    e.preventDefault();
  };
  const onFloatTouchEnd = () => { floatDragging.current = false; };
  const onFloatMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); floatDragging.current = true; floatMoved.current = false;
    floatStart.current = { px: e.clientX, py: e.clientY, bx: floatPos.x, by: floatPos.y };
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - floatStart.current.px; const dy = ev.clientY - floatStart.current.py;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) floatMoved.current = true;
      setFloatPos({ x: Math.max(8, Math.min(window.innerWidth - 68, floatStart.current.bx + dx)), y: Math.max(8, Math.min(window.innerHeight - 68, floatStart.current.by + dy)) });
    };
    const onUp = () => { floatDragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };

  // ── Download as HTML (MHTML-style) ──
  const handleDownload = () => {
    const savedOn = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const safeQuery = query.replace(/[<>"&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;','&':'&amp;'}[c]||c));

    let bodyHtml = '';
    if (mode === 'topic-compare' && topicResult) {
      const commonRows = topicResult.common.map((pt, i) =>
        `<li style="margin:6px 0;padding:8px 12px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:6px;">${i+1}. ${pt.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]||c))}</li>`
      ).join('');
      const extraRows = topicResult.extra.map(({ bookName, pageNo, points, topicTitle }) => {
        if (points.length === 0) return '';
        const pts = points.map((pt, i) =>
          `<li style="margin:5px 0;padding:7px 10px;background:#f5f3ff;border-left:3px solid #7c3aed;border-radius:6px;">${i+1}. ${pt.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]||c))}</li>`
        ).join('');
        return `<div style="margin-top:18px;"><h3 style="color:#5b21b6;font-size:14px;margin:0 0 8px;">📚 ${bookName.replace(/[<>&]/g,'?')}${pageNo?` — Page ${pageNo}`:''}${topicTitle?` · ${topicTitle}`:''}</h3><ul style="list-style:none;margin:0;padding:0;">${pts}</ul></div>`;
      }).join('');
      bodyHtml = `<h2 style="color:#059669;font-size:16px;margin:0 0 10px;">✅ Common Points (${topicResult.common.length})</h2><ul style="list-style:none;margin:0;padding:0;">${commonRows || '<li style="color:#94a3b8;font-style:italic;">No common points found.</li>'}</ul>${extraRows ? `<hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0;"/><h2 style="color:#7c3aed;font-size:16px;margin:0 0 10px;">🔖 Extra Points (per book)</h2>${extraRows}` : ''}`;
    } else {
      bodyHtml = books.map((h, i) => {
        const content = (h.noteFullContent || h.noteContent || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]||c)).replace(/\n/g,'<br/>');
        return `<div style="margin-bottom:24px;"><h3 style="color:#4f46e5;font-size:15px;margin:0 0 8px;">📚 ${i+1}. ${(h.bookName||h.subjectName).replace(/[<>&]/g,'?')}${h.pageNo?` — Page ${h.pageNo}`:''}</h3><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;line-height:1.8;font-size:14px;">${content}</div></div>`;
      }).join('');
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IIC · Compare: ${safeQuery}</title>
  <style>
    body { margin:0; padding:0; font-family: 'Segoe UI', system-ui, sans-serif; background:#f1f5f9; color:#0f172a; }
    .topbar { background: linear-gradient(135deg,#4f46e5,#7c3aed); color:#fff; padding:14px 20px; display:flex; align-items:center; gap:14px; position:sticky; top:0; z-index:50; box-shadow:0 4px 12px rgba(0,0,0,0.15); }
    .logo { width:40px; height:40px; border-radius:12px; background:rgba(255,255,255,0.18); display:flex; align-items:center; justify-content:center; font-weight:900; font-size:18px; }
    .title-block { flex:1; }
    .app-label { font-size:11px; font-weight:800; letter-spacing:.2em; text-transform:uppercase; opacity:.8; margin:0; }
    .page-title { font-size:16px; font-weight:800; margin:2px 0 0; }
    .badge { font-size:10px; font-weight:800; text-transform:uppercase; background:rgba(0,0,0,0.2); padding:4px 10px; border-radius:999px; }
    .subhead { background:#fff; border-bottom:1px solid #e2e8f0; padding:10px 20px; font-size:12px; color:#64748b; display:flex; justify-content:space-between; }
    .main { padding:20px; display:flex; justify-content:center; }
    .card { background:#fff; width:100%; max-width:900px; border:1px solid #e2e8f0; border-radius:18px; box-shadow:0 10px 30px -10px rgba(0,0,0,0.12); padding:24px; }
    .footer { padding:18px 20px 26px; text-align:center; font-size:11px; color:#64748b; border-top:1px solid #e2e8f0; background:#fff; }
    @media print { .topbar { position:static; } }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">IIC</div>
    <div class="title-block">
      <p class="app-label">IIC</p>
      <h1 class="page-title">Compare: ${safeQuery}</h1>
    </div>
    <span class="badge">Saved · Offline</span>
  </div>
  <div class="subhead"><span>${books.length} books compared</span><span>Saved on ${savedOn}</span></div>
  <div class="main"><div class="card">${bodyHtml}</div></div>
  <div class="footer">Saved from <strong>IIC</strong> — Compare Mode.<br/>This is a static snapshot for offline reading.</div>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compare_${query.replace(/\s+/g, '_').slice(0, 40)}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  return (
    <div className="fixed inset-0 z-[250] bg-white flex flex-col overflow-hidden">

      {/* Header */}
      {!focusMode && (
        <div className="bg-gradient-to-r from-violet-700 to-indigo-700 text-white px-3 py-1.5 flex items-center gap-2 shrink-0 shadow-lg">
          <GitCompare size={16} className="shrink-0 opacity-80" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-black leading-tight text-white truncate">
              {books.length === 0
                ? `"${query}" — nahi mila`
                : books.length === 1
                  ? `"${query}" — 1 book`
                  : `"${query}" — ${books.length} books`}
            </p>
          </div>
          {!isUltra && (
            <div className="flex items-center gap-0.5 bg-white/20 px-2 py-1 rounded-lg shrink-0">
              <span className="text-[10px] font-black text-violet-100">{remainingToday}/{FREE_DAILY_LIMIT}</span>
              <span className="text-[9px] text-violet-300 ml-0.5">aaj</span>
            </div>
          )}
          <button onClick={handleDownload} className="flex items-center gap-1 bg-white/20 hover:bg-white/30 text-white px-2 py-1 rounded-lg text-[10px] font-bold transition-all active:scale-95 shrink-0">
            <Download size={11} /> Save
          </button>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-white/20 transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>
      )}

      {/* Daily Limit Wall */}
      {limitReached && (
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 bg-slate-50">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
            <Lock size={30} className="text-amber-600" />
          </div>
          <h3 className="text-lg font-black text-slate-800 mb-1">Aaj ki limit poori ho gayi!</h3>
          <p className="text-sm text-slate-500 text-center mb-2">
            Free mein aap ek din mein <strong>{FREE_DAILY_LIMIT} topics</strong> compare kar sakte hain.
          </p>
          <p className="text-xs text-slate-400 text-center mb-6">Kal fir {FREE_DAILY_LIMIT} topics milenge — ya Ultra lo aur unlimited compare karo.</p>
          <div className="flex flex-col gap-3 w-full max-w-xs">
            <div className="bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl px-5 py-3.5 flex items-center gap-3 shadow-lg">
              <Crown size={22} />
              <div>
                <p className="font-black text-sm">Ultra lo — Unlimited</p>
                <p className="text-[11px] text-amber-100">Ek baar — lifetime access milega</p>
              </div>
            </div>
            <button onClick={onClose} className="text-xs text-slate-400 py-2 hover:text-slate-600 transition-colors">
              Kal aana — Band karo
            </button>
          </div>
        </div>
      )}

      {/* Mode tabs */}
      {!focusMode && !limitReached && (
        <div className="flex bg-slate-100 p-0.5 gap-0.5 shrink-0 mx-2 mt-1.5 mb-0.5 rounded-lg">
          {!isSingleBook && (
            <button onClick={() => setMode('topic-compare')} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'topic-compare' ? 'bg-white shadow text-emerald-700' : 'text-slate-500'}`}>
              <Shuffle size={11} /> Compare
            </button>
          )}
          <button onClick={() => setMode('book-by-book')} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'book-by-book' ? 'bg-white shadow text-violet-700' : 'text-slate-500'}`}>
            <BookOpen size={11} /> {isSingleBook ? 'Notes' : 'Book Wise'}
          </button>
          <button onClick={() => setMode('read-all')} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'read-all' ? 'bg-white shadow text-violet-700' : 'text-slate-500'}`}>
            <Volume2 size={11} /> Read All
          </button>
          <button onClick={() => { setMode('book-notes'); loadCnNotes(); }} className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'book-notes' ? 'bg-white shadow text-indigo-700' : 'text-slate-500'}`}>
            <GitCompare size={11} /> Book Notes
          </button>
        </div>
      )}

      {/* Focus mode mini bar */}
      {focusMode && (
        <div className="flex items-center justify-between px-4 py-2 bg-slate-900 text-white shrink-0">
          <span className="text-xs font-bold text-slate-400 truncate">"{query}"</span>
          <button onClick={() => setFocusMode(false)} className="flex items-center gap-1.5 text-xs font-bold text-slate-300 hover:text-white">
            <Minimize2 size={14} /> Exit Focus
          </button>
        </div>
      )}

      {/* ── Content ── */}
      {!limitReached && <div className="flex-1 overflow-y-auto pb-20">

        {/* ── TOPIC COMPARE MODE ── */}
        {mode === 'topic-compare' && (
          <div className="px-2 pt-2 space-y-2">

            {/* ── 📌 Pin-Topic Picker (shown when notes have 📌 sections) ── */}
            {pinTopics.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl overflow-hidden">
                <div className="px-3 py-2 flex items-center gap-2">
                  <span className="text-base">📌</span>
                  <p className="text-[11px] font-black text-amber-800">Topic chunein — sirf us topic ka compare hoga</p>
                </div>
                <div className="flex gap-2 overflow-x-auto px-3 pb-3 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
                  <button
                    onClick={() => setActiveTopicQuery(query)}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black border transition-all ${activeTopicQuery === query ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-amber-700 border-amber-300 hover:bg-amber-100'}`}
                  >
                    🔍 Sab
                  </button>
                  {pinTopics.map((topic, ti) => (
                    <button
                      key={ti}
                      onClick={() => setActiveTopicQuery(topic)}
                      className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black border transition-all max-w-[200px] truncate ${activeTopicQuery === topic ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-amber-700 border-amber-300 hover:bg-amber-100'}`}
                      title={topic}
                    >
                      📌 {topic.length > 30 ? topic.substring(0, 30) + '…' : topic}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {topicLoading && (
              <div className="text-center py-12">
                <div className="w-10 h-10 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm font-bold text-slate-500">Topic-wise compare ho raha hai...</p>
                <p className="text-xs text-slate-400 mt-1">{books.length} books se
                  {books.some(b => b.topicName)
                    ? ` tagged topic "${books.find(b => b.topicName)?.topicName}" ka pura section nikal raha hai`
                    : ` sirf "${activeTopicQuery}" wala section nikal raha hai`}
                </p>
              </div>
            )}

            {!topicLoading && topicResult && (
              <>
                {/* Book + Topic info strip */}
                <div className="flex flex-wrap gap-1.5">
                  {books.map((h, i) => {
                    const bookName = h.bookName || h.subjectName;
                    const bookExtra = topicResult.extra[i];
                    return (
                      <div key={i} className="flex items-center gap-1.5 bg-violet-50 border border-violet-200 rounded-xl px-2.5 py-1 min-w-0 max-w-full">
                        <span className="w-4 h-4 rounded-full bg-violet-600 text-white text-[9px] font-black flex items-center justify-center shrink-0">{i + 1}</span>
                        <span className="text-[10px] font-black text-violet-800 truncate">{bookName}</span>
                        {h.pageNo && <span className="text-[9px] text-violet-400 font-medium shrink-0">p.{h.pageNo}</span>}
                        {bookExtra?.topicTitle && (
                          <span className="flex items-center gap-0.5">
                            <MapPin size={9} className="text-emerald-500 shrink-0" />
                            <span className="text-[9px] text-emerald-700 font-bold truncate max-w-[80px]">{bookExtra.topicTitle}</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* ── COMMON POINTS ── */}
                <div className="rounded-xl border-2 border-emerald-400 overflow-hidden shadow-sm">
                  <div className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-3 py-1.5 flex items-center gap-2">
                    <CheckCircle2 size={14} className="shrink-0" />
                    <div className="flex-1">
                      <p className="text-xs font-black">Common Points {topicResult.common.length > 0 ? `(${topicResult.common.length})` : ''}</p>
                    </div>
                  </div>
                  {topicResult.common.length === 0 ? (
                    <div className="bg-white px-4 py-5 text-center">
                      <p className="text-xs text-slate-400">Books ke notes kaafi alag hain — neeche har book ke extra points dekh sakte hain.</p>
                    </div>
                  ) : (
                    <div className="bg-white px-3 pb-2">
                      <ChunkedNotesReader
                        key={`compare-common-${query}`}
                        content={topicResult.common.join('\n')}
                        topBarLabel="Common Points"
                        searchQuery={query}
                        language="hi-IN"
                      />
                    </div>
                  )}
                </div>

                {/* ── EXTRA POINTS (per book) ── */}
                {topicResult.extra.map(({ bookName, pageNo, points, topicTitle }, bi) => {
                  if (points.length === 0) return null;
                  return (
                    <div key={bi} className="rounded-xl border border-violet-200 overflow-hidden shadow-sm">
                      <div className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-white/20 text-white font-black text-[10px] flex items-center justify-center shrink-0">{bi + 1}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-black truncate">{bookName}{pageNo ? ` · p.${pageNo}` : ''} <span className="font-normal text-violet-200">({points.length} extra)</span></p>
                          </div>
                        </div>
                        {topicTitle && (
                          <div className="flex items-center gap-1 ml-7 mt-0.5">
                            <MapPin size={9} className="text-emerald-300 shrink-0" />
                            <span className="text-[9px] text-emerald-200 font-bold truncate">{topicTitle}</span>
                          </div>
                        )}
                      </div>
                      <div className="bg-white px-3 pb-2">
                        <ChunkedNotesReader
                          key={`compare-extra-${bi}-${query}`}
                          content={points.join('\n')}
                          topBarLabel={`${bookName}${pageNo ? ` · Pg ${pageNo}` : ''}`}
                          searchQuery={query}
                          language="hi-IN"
                        />
                      </div>
                    </div>
                  );
                })}

                <button
                  onClick={loadTopicCompare}
                  className="w-full py-2.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl hover:bg-emerald-100 transition-colors"
                >
                  🔄 Dobara Compare Karein
                </button>
              </>
            )}

            {!topicLoading && !topicResult && (
              <div className="text-center py-10">
                <p className="text-xs text-slate-400 mb-3">Data load nahi hua.</p>
                <button onClick={loadTopicCompare} className="px-5 py-2 bg-emerald-600 text-white text-xs font-bold rounded-xl">Retry</button>
              </div>
            )}
          </div>
        )}

        {/* ── BOOK WISE MODE ── */}
        {mode === 'book-by-book' && (
          <div className="space-y-2 px-2 pt-2">
            {books.map((h, i) => {
              const bookName = h.bookName || h.subjectName;
              const classInfo = h.classLevel === 'COMPETITION' ? 'Competition' : `Class ${h.classLevel}`;
              const isOpen = expandedBooks.has(i);
              return (
                <div key={`${h.storageKey}_${i}`} className="rounded-xl border border-violet-100 overflow-hidden shadow-sm">
                  <button
                    className="w-full flex items-center gap-2 bg-gradient-to-r from-violet-50 to-indigo-50 px-3 py-2 text-left"
                    onClick={() => toggleBook(i)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-violet-600 text-white flex items-center justify-center font-black text-xs shrink-0">{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-black text-slate-800 truncate">{bookName}</p>
                      <p className="text-[9px] font-bold text-violet-500">
                        {classInfo}{h.pageNo ? ` · p.${h.pageNo}` : ''} · {h.matchCount} match{h.matchCount !== 1 ? 'es' : ''}
                      </p>
                    </div>
                    {isOpen ? <ChevronUp size={14} className="text-violet-400 shrink-0" /> : <ChevronDown size={14} className="text-violet-400 shrink-0" />}
                  </button>
                  {isOpen && (
                    <div className="bg-white px-3 pb-2">
                      {h.matchedWords && h.matchedWords.length > 0 && (
                        <div className="flex flex-wrap gap-1 px-1 pt-2 pb-1">
                          {h.matchedWords.map((w, wi) => (
                            <span key={wi} className="bg-violet-100 text-violet-700 text-[10px] font-black px-2 py-0.5 rounded-full">{w}</span>
                          ))}
                        </div>
                      )}
                      <ChunkedNotesReader
                        key={`compare-book-${i}-${query}`}
                        content={h.noteFullContent || h.noteContent || ''}
                        topBarLabel={`${bookName}${h.pageNo ? ` · Pg ${h.pageNo}` : ''}`}
                        searchQuery={query}
                        language="hi-IN"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── READ ALL MODE ── */}
        {mode === 'read-all' && (() => {
          // Use topic-extracted sections if available, else fallback to full content
          let readContent = '';
          if (extractedSections.length > 0) {
            // Common points first (only for multi-book compare)
            const commonBlock = (!isSingleBook && topicResult && topicResult.common.length > 0)
              ? `✅ COMMON POINTS (sabhi books mein):\n${topicResult.common.join('\n')}\n\n---\n\n`
              : '';
            const bookBlocks = extractedSections.map(sec => {
              const header = `📚 ${sec.bookName}${sec.pageNo ? ` (Page ${sec.pageNo})` : ''}${sec.topicTitle ? `\n📌 ${sec.topicTitle}` : ''}`;
              return `${header}\n\n${sec.text}`;
            }).join('\n\n---\n\n');
            readContent = commonBlock + bookBlocks;
          } else {
            // Fallback: full content
            readContent = combinedContent;
          }
          return (
            <div className="px-3 pt-3">
              {readContent.trim() ? (
                <ChunkedNotesReader
                  content={readContent}
                  topBarLabel={`Read: ${query}`}
                  searchQuery={query}
                  language="hi-IN"
                />
              ) : (
                <div className="text-center py-12">
                  <p className="text-2xl mb-2">📭</p>
                  <p className="text-sm font-bold text-slate-500">Koi content nahi mila</p>
                  <p className="text-xs text-slate-400 mt-1">"{query}" topic ka content kisi book mein available nahi hai.</p>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── BOOK NOTES MODE ── */}
        {mode === 'book-notes' && (
          <div className="px-2 pt-2">
            {cnNotesLoading && (
              <div className="text-center py-12">
                <div className="w-8 h-8 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"/>
                <p className="text-xs font-bold text-slate-500">Book notes load ho rahe hain…</p>
              </div>
            )}

            {!cnNotesLoading && cnAllNotes !== null && cnTopics.length === 0 && (
              <div className="text-center py-12">
                <p className="text-3xl mb-3">📭</p>
                <p className="text-sm font-bold text-slate-600">Koi Book Notes nahi hain</p>
                <p className="text-xs text-slate-400 mt-1">Admin se compare book notes add karwayein</p>
              </div>
            )}

            {!cnNotesLoading && cnTopics.length > 0 && (
              <div className="space-y-3">
                {/* ── Topic navigation pills ── */}
                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl overflow-hidden">
                  <div className="px-3 py-2 flex items-center gap-2">
                    <span className="text-base">📌</span>
                    <p className="text-[11px] font-black text-indigo-800">Topic chunein — us topic ke saare books ke notes dikhenge</p>
                  </div>
                  <div className="flex gap-2 overflow-x-auto px-3 pb-3 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {cnTopics.map((topic, ti) => (
                      <button
                        key={ti}
                        onClick={() => setCnActiveTopic(topic)}
                        className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black border transition-all ${cnActiveTopic === topic ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50'}`}
                        title={topic}
                      >
                        📌 {topic.length > 30 ? topic.substring(0, 30) + '…' : topic}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Notes for selected topic ── */}
                {cnActiveTopic && cnActiveEntries.length > 0 && (
                  <div className="space-y-2">
                    {/* Book count chip */}
                    <div className="flex flex-wrap gap-1.5 px-0.5">
                      {cnActiveEntries.map((entry, ei) => (
                        <div key={ei} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-xl px-2.5 py-1">
                          <span className="w-4 h-4 rounded-full bg-indigo-600 text-white text-[9px] font-black flex items-center justify-center shrink-0">{ei + 1}</span>
                          <span className="text-[10px] font-black text-indigo-800 truncate max-w-[120px]">{entry.bookLabel}</span>
                          {entry.note.pageNumber && entry.note.pageNumber !== '—' && (
                            <span className="text-[9px] text-indigo-400 font-medium shrink-0">p.{entry.note.pageNumber}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Per-book notes */}
                    {cnActiveEntries.map((entry, ei) => (
                      <div key={entry.note.id} className="rounded-xl border border-indigo-200 overflow-hidden shadow-sm">
                        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-3 py-1.5 flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-white/20 font-black text-[10px] flex items-center justify-center shrink-0">{ei + 1}</span>
                          <span className="text-[11px] font-black flex-1 truncate">{entry.bookLabel}</span>
                          {entry.note.pageNumber && entry.note.pageNumber !== '—' && (
                            <span className="text-[9px] text-indigo-200 shrink-0">Pg {entry.note.pageNumber}</span>
                          )}
                        </div>
                        <div className="bg-white px-3 pb-2">
                          <ChunkedNotesReader
                            key={`cn-${entry.note.id}`}
                            content={entry.note.notes}
                            topBarLabel={entry.bookLabel}
                            searchQuery={cnActiveTopic ?? ''}
                            language="hi-IN"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>}

      {/* ── Floating Focus Button ── */}
      <div
        style={{ position: 'fixed', left: floatPos.x, top: floatPos.y, zIndex: 350, touchAction: 'none', userSelect: 'none' }}
        onTouchStart={onFloatTouchStart}
        onTouchMove={onFloatTouchMove}
        onTouchEnd={onFloatTouchEnd}
        onMouseDown={onFloatMouseDown}
      >
        <button
          onClick={() => { if (!floatMoved.current) setFocusMode(prev => !prev); }}
          className={`w-14 h-14 rounded-full text-white shadow-2xl flex flex-col items-center justify-center gap-0.5 active:scale-95 transition-transform border-2 border-white/30 ${focusMode ? 'bg-gradient-to-br from-slate-700 to-slate-900' : 'bg-gradient-to-br from-violet-600 to-indigo-600'}`}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          {focusMode
            ? <><Minimize2 size={20} /><span className="text-[8px] font-black leading-none">EXIT</span></>
            : <><Maximize2 size={20} /><span className="text-[8px] font-black leading-none">FOCUS</span></>
          }
        </button>
      </div>
    </div>
  );
};
