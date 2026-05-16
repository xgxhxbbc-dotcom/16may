import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Download, CheckCircle2, BookOpen, GitCompare, ChevronLeft, ChevronRight, Crown, Search, Trash2, ChevronDown, ChevronUp, Loader2, Play, Headphones } from 'lucide-react';
import { ChunkedNotesReader } from './ChunkedNotesReader';
import type { SystemSettings } from '../types';
import { getCompreBookNotes, type CompreNote } from '../firebase';

const POINTS_PER_PAGE = 50;

// ── Comparison helpers ──
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
    .split(/[\n।\|]+/)
    .map(s => s
      .replace(/^[\s📌📚🔹🔸▪•●\-\*→>\d]+[\.\)\:]\s*/, '')
      .replace(/^[\s📌📚🔹🔸▪•●\-\*→>\d]+\s+/, '')
      .trim()
    )
    .filter(s => s.length >= 8 && !/^(page|date|notes|pg)\s*[:—]/i.test(s));
}

function computeFullBookComparison(bookContents: { bookName: string; text: string }[]): {
  common: string[];
  extra: { bookName: string; points: string[] }[];
} {
  if (bookContents.length === 0) return { common: [], extra: [] };
  const bookPoints = bookContents.map(bc => ({
    bookName: bc.bookName,
    points: splitIntoPoints(bc.text.substring(0, 80000)),
  }));
  const common: string[] = [];
  const usedCommon = new Set<string>();
  const extraPerBook = bookPoints.map(b => ({ bookName: b.bookName, points: [] as string[] }));
  bookPoints.forEach((book, bi) => {
    book.points.forEach(point => {
      let matchedInOther = false;
      for (let other = 0; other < bookPoints.length; other++) {
        if (other === bi) continue;
        if (bookPoints[other].points.some(p => wordOverlap(point, p) >= 0.4)) {
          matchedInOther = true;
          break;
        }
      }
      if (matchedInOther) {
        const norm = normalizeSentence(point);
        if (!usedCommon.has(norm) && !common.some(c => wordOverlap(point, c) >= 0.65)) {
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

// Standard book names map
const HW_LABELS: Record<string, string> = {
  sarSangrah: 'Sar Sangrah',
  speedyScience: 'Speedy Science',
  speedySocialScience: 'Speedy Social Science',
  lucent: 'Lucent GK',
};
const COMPRE_BOOK_NAMES: Record<string, string> = {
  lucent: 'Lucent GK',
  sarSangrah: 'Sar Sangrah',
  speedyScience: 'Speedy Science',
  speedySocialScience: 'Speedy Social Science',
};

interface Props {
  settings: SystemSettings | null;
  user?: { subscriptionLevel?: string; isPremium?: boolean; isAdmin?: boolean };
  isLimited?: boolean;
  freeLimit?: number;
  onClose: () => void;
  isFocusMode?: boolean;
}

export const FullBookCompare: React.FC<Props> = ({ settings, user, isLimited = false, freeLimit = 4, onClose, isFocusMode = false }) => {
  const isAdmin = !!(user?.isAdmin);

  // ── Search state ──
  const [searchWord, setSearchWord] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Compare state ──
  const [processing, setProcessing] = useState(true);
  const [result, setResult] = useState<{ common: string[]; extra: { bookName: string; points: string[] }[] } | null>(null);
  const [bookContents, setBookContents] = useState<{ bookName: string; text: string }[]>([]);
  const [tab, setTab] = useState<'search' | 'common' | 'extra' | 'download'>('search');
  const [commonPage, setCommonPage] = useState(0);
  const [activeExtraBook, setActiveExtraBook] = useState<string | null>(null);
  const [extraPages, setExtraPages] = useState<Record<string, number>>({});
  const [topicResult, setTopicResult] = useState<{ common: string[]; extra: { bookName: string; points: string[] }[]; topicName: string } | null>(null);

  // ── Compre notes (Firestore) — loaded at mount for search ──
  const [allCompreNotes, setAllCompreNotes] = useState<Record<string, CompreNote[]>>({});
  const [compreLoading, setCompreLoading] = useState(true);

  // ── Subject filter ──
  const [compreSubject, setCompreSubject] = useState<string>('all');
  const SUBJECT_FILTERS = [
    { id: 'all',    label: 'All' },
    { id: 'phy',    label: 'Physics' },
    { id: 'che',    label: 'Chemistry' },
    { id: 'bio',    label: 'Biology' },
    { id: 'his',    label: 'History' },
    { id: 'geo',    label: 'Geography' },
    { id: 'polity', label: 'Polity' },
    { id: 'eco',    label: 'Economics' },
  ] as const;

  useEffect(() => {
    const customBooks = ((settings as any)?.customBooks || []) as Array<{ id: string; name: string }>;
    customBooks.forEach(b => { if (b.id && b.name) COMPRE_BOOK_NAMES[b.id] = b.name; });

    const lucentBookIds = ((settings?.lucentNotes || []) as any[]).reduce((acc: string[], entry: any) => {
      const name = (entry.bookName?.trim()) || 'Lucent GK';
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      if (!acc.includes(id)) acc.push(id);
      return acc;
    }, []);

    const bookIds = Array.from(new Set([
      'lucent', 'sarSangrah', 'speedyScience', 'speedySocialScience',
      ...lucentBookIds,
      ...customBooks.map(b => b.id),
    ]));

    setCompreLoading(true);
    Promise.all(
      bookIds.map(id =>
        getCompreBookNotes(id)
          .then(notes => ({ id, notes }))
          .catch(() => ({ id, notes: [] as CompreNote[] }))
      )
    ).then(results => {
      const map: Record<string, CompreNote[]> = {};
      results.forEach(r => { if (r.notes.length > 0) map[r.id] = r.notes; });
      setAllCompreNotes(map);
      setCompreLoading(false);
    }).catch(() => setCompreLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build bookContents for full compare ──
  useEffect(() => {
    const stripHtml = (s: string) => (s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const bookMap = new Map<string, string[]>();

    const lucentNotes = ((settings?.lucentNotes || []) as any[])
      .filter((n: any) => !n.classLevel || n.classLevel === 'COMPETITION');
    lucentNotes.forEach((entry: any) => {
      const bookName = (entry.bookName?.trim()) || 'Lucent GK';
      if (!bookMap.has(bookName)) bookMap.set(bookName, []);
      const pageText = (entry.pages || []).map((p: any) => stripHtml(p.content || '')).join('\n');
      if (pageText.trim()) bookMap.get(bookName)!.push(pageText);
    });

    const customBooks = ((settings as any)?.customBooks || []) as Array<{ id: string; name: string }>;
    const labels: Record<string, string> = { ...HW_LABELS };
    customBooks.forEach(b => { if (b.id !== 'mcq') labels[b.id] = b.name; });

    const allHw = (settings?.homework || []) as any[];
    Object.entries(labels).forEach(([bookId, bookName]) => {
      const items = allHw.filter((hw: any) => hw.targetSubject === bookId && hw.notes?.trim());
      if (items.length === 0) return;
      if (!bookMap.has(bookName)) bookMap.set(bookName, []);
      items.forEach((hw: any) => bookMap.get(bookName)!.push(stripHtml(hw.notes || '')));
    });

    const contents = Array.from(bookMap.entries())
      .map(([bookName, chunks]) => ({ bookName, text: chunks.join('\n') }))
      .filter(b => b.text.trim().length > 20);

    setBookContents(contents);
    setTimeout(() => {
      if (contents.length < 2) {
        setResult({ common: [], extra: contents.map(b => ({ bookName: b.bookName, points: splitIntoPoints(b.text) })) });
      } else {
        setResult(computeFullBookComparison(contents));
      }
      setProcessing(false);
    }, 80);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Word search results ──
  const wordSearchResults = useMemo(() => {
    const word = searchWord.trim().toLowerCase();
    if (word.length < 2) return [];
    // Normalized word: strip emojis/symbols for point-level matching
    // (splitIntoPoints strips leading emojis from lines, so "📌 X" becomes "X")
    const wordNorm = word.replace(/[^\u0900-\u097fa-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    const stripHtml = (s: string) => (s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

    const bookData = new Map<string, string[]>(); // bookName → matching text chunks
    const addMatch = (bookName: string, text: string) => {
      if (!bookData.has(bookName)) bookData.set(bookName, []);
      bookData.get(bookName)!.push(text);
    };

    // 1. Lucent notes pages
    ((settings?.lucentNotes || []) as any[]).forEach((entry: any) => {
      const bookName = (entry.bookName?.trim()) || 'Lucent GK';
      (entry.pages || []).forEach((pg: any) => {
        const content = stripHtml(pg.content || '');
        if (content.toLowerCase().includes(word)) addMatch(bookName, content);
      });
    });

    // 2. Homework book-wise notes
    const customBooks = ((settings as any)?.customBooks || []) as Array<{ id: string; name: string }>;
    const labels: Record<string, string> = { ...HW_LABELS };
    customBooks.forEach(b => { if (b.id && b.name) labels[b.id] = b.name; });
    ((settings?.homework || []) as any[]).forEach((hw: any) => {
      const notes = stripHtml(hw.notes || '');
      if (notes.toLowerCase().includes(word)) {
        const bookName = labels[hw.targetSubject || ''] || 'Notes';
        addMatch(bookName, notes);
      }
    });

    // 3. Compre notes from Firestore/RTDB (filtered by subject)
    // These are handled separately to avoid splitIntoPoints stripping emoji from topicName
    const compreBookData = new Map<string, { points: string[]; totalText: string }>();
    Object.entries(allCompreNotes).forEach(([bookId, notes]) => {
      const bookName = COMPRE_BOOK_NAMES[bookId] || bookId;
      const filtered = compreSubject === 'all'
        ? (notes || [])
        : (notes || []).filter((n: CompreNote) => n.subject === compreSubject);
      filtered.forEach((note: CompreNote) => {
        const cleanTopic = (note.topicName || '').replace(/^[\s📌📚🔹🔸▪•●\-\*→>\d]+\s*/, '').trim();
        const searchText = [note.topicName, note.pageNumber !== '—' ? note.pageNumber : '', note.notes].filter(Boolean).join('\n');
        const matchesWord = searchText.toLowerCase().includes(word);
        const matchesNorm = wordNorm.length >= 2 && searchText.toLowerCase().includes(wordNorm);
        if (matchesWord || matchesNorm) {
          if (!compreBookData.has(bookName)) compreBookData.set(bookName, { points: [], totalText: '' });
          const entry = compreBookData.get(bookName)!;
          // Add topic as a point if it's meaningful, then add content lines
          if (cleanTopic && cleanTopic.length >= 2) entry.points.push(cleanTopic);
          (note.notes || '').split('\n').map(l => l.trim()).filter(l => l.length >= 3).forEach(l => entry.points.push(l));
          entry.totalText += (entry.totalText ? '\n' : '') + [cleanTopic, note.notes].filter(Boolean).join('\n');
        }
      });
    });

    const regularResults = Array.from(bookData.entries()).map(([bookName, chunks]) => {
      const allText = chunks.join('\n');
      const allPoints = splitIntoPoints(allText);
      const matchingPoints = allPoints.filter(p =>
        p.toLowerCase().includes(word) || (wordNorm.length >= 2 && p.toLowerCase().includes(wordNorm))
      );
      return { bookName, points: matchingPoints, totalText: allText };
    }).filter(r => r.points.length > 0);

    const compreResults = Array.from(compreBookData.entries())
      .map(([bookName, data]) => ({ bookName, points: data.points, totalText: data.totalText }))
      .filter(r => r.points.length > 0);

    // Merge: if a bookName appears in both, combine points
    const merged = [...regularResults];
    compreResults.forEach(cr => {
      const existing = merged.find(r => r.bookName === cr.bookName);
      if (existing) {
        existing.points = [...existing.points, ...cr.points];
        existing.totalText += '\n' + cr.totalText;
      } else {
        merged.push(cr);
      }
    });
    return merged;
  }, [searchWord, settings, allCompreNotes, compreSubject]);

  // ── All unique topics from loaded compre notes (for topic list) ──
  const allCompreTopics = useMemo(() => {
    const topicMap = new Map<string, { topicName: string; groupId?: string; books: string[]; createdAt: string }>();
    Object.entries(allCompreNotes).forEach(([bookId, notes]) => {
      const bookName = COMPRE_BOOK_NAMES[bookId] || bookId;
      const filtered = compreSubject === 'all'
        ? (notes || [])
        : (notes || []).filter(n => n.subject === compreSubject);
      filtered.forEach(note => {
        const key = note.groupId || note.topicName || note.id;
        if (!topicMap.has(key)) {
          topicMap.set(key, { topicName: note.topicName || '(Untitled)', groupId: note.groupId, books: [], createdAt: note.createdAt });
        }
        const entry = topicMap.get(key)!;
        if (!entry.books.includes(bookName)) entry.books.push(bookName);
        if (note.createdAt > entry.createdAt) entry.createdAt = note.createdAt;
      });
    });
    return Array.from(topicMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [allCompreNotes, compreSubject]);

  // ── Click a topic → directly open comparison ──
  const handleTopicSelect = useCallback((topicName: string, groupId?: string) => {
    const bookContentsForTopic: { bookName: string; text: string }[] = [];
    Object.entries(allCompreNotes).forEach(([bookId, notes]) => {
      const bookName = COMPRE_BOOK_NAMES[bookId] || bookId;
      const filtered = compreSubject === 'all'
        ? (notes || [])
        : (notes || []).filter(n => n.subject === compreSubject);
      const matchingNotes = filtered.filter(n =>
        groupId ? n.groupId === groupId : (n.topicName === topicName)
      );
      if (matchingNotes.length > 0) {
        const text = matchingNotes.map(n => n.notes || '').filter(Boolean).join('\n');
        if (text.trim()) bookContentsForTopic.push({ bookName, text });
      }
    });
    if (bookContentsForTopic.length === 0) return;
    const comparison = bookContentsForTopic.length >= 2
      ? computeFullBookComparison(bookContentsForTopic)
      : { common: [], extra: bookContentsForTopic.map(b => ({ bookName: b.bookName, points: splitIntoPoints(b.text) })) };
    setTopicResult({ ...comparison, topicName });
    setActiveExtraBook(comparison.extra[0]?.bookName ?? null);
    setExtraPages({});
    setCommonPage(0);
    setTab(bookContentsForTopic.length >= 2 ? 'common' : 'extra');
  }, [allCompreNotes, compreSubject]);

  // ── Open word comparison across books ──
  const openWordCompare = useCallback(() => {
    if (wordSearchResults.length === 0) return;
    const contents = wordSearchResults.map(r => ({ bookName: r.bookName, text: r.totalText }));
    const comparison = contents.length >= 2
      ? computeFullBookComparison(contents)
      : { common: [], extra: contents.map(b => ({ bookName: b.bookName, points: splitIntoPoints(b.text) })) };
    setTopicResult({ ...comparison, topicName: searchWord.trim() });
    setActiveExtraBook(comparison.extra[0]?.bookName ?? null);
    setExtraPages({});
    setCommonPage(0);
    setTab(contents.length >= 2 ? 'common' : 'extra');
  }, [wordSearchResults, searchWord]);

  // ── Download ──
  const handleDownload = (type: 'common' | 'all' | string) => {
    const active = topicResult ?? result;
    if (!active) return;
    const prefix = topicResult ? `"${topicResult.topicName}" — ` : '';
    const savedOn = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const esc = (s: string) => s.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]||c));
    const pointList = (pts: string[], color: string) =>
      pts.map((p, i) => `<li style="margin:5px 0;padding:8px 12px;background:${color};border-radius:7px;list-style:none;">${i+1}. ${esc(p)}</li>`).join('');

    let bodyHtml = '';
    let titleLabel = '';
    if (type === 'common') {
      titleLabel = `${prefix}Common Points`;
      bodyHtml = `<h2 style="color:#059669;font-size:16px;margin:0 0 12px;">✅ Common Points (${active.common.length})</h2><ul style="padding:0;margin:0;">${pointList(active.common, '#f0fdf4') || '<li style="color:#94a3b8;font-style:italic;list-style:none;">No common points.</li>'}</ul>`;
    } else if (type === 'all') {
      titleLabel = `${prefix}Full Book Compare`;
      const commonBlock = `<h2 style="color:#059669;font-size:15px;margin:0 0 10px;">✅ Common Points (${active.common.length})</h2><ul style="padding:0;margin:0 0 24px;">${pointList(active.common, '#f0fdf4') || '<li style="color:#94a3b8;font-style:italic;list-style:none;">No common points.</li>'}</ul>`;
      const extraBlocks = active.extra.map(({ bookName, points }) =>
        `<div style="margin-bottom:20px;"><h3 style="color:#7c3aed;font-size:14px;margin:0 0 8px;">📚 ${esc(bookName)} — Extra (${points.length})</h3><ul style="padding:0;margin:0;">${pointList(points, '#f5f3ff')}</ul></div>`
      ).join('');
      bodyHtml = commonBlock + `<hr style="border:none;border-top:2px solid #e2e8f0;margin:24px 0;"/>` + `<h2 style="color:#7c3aed;font-size:15px;margin:0 0 12px;">🔖 Extra Points (per book)</h2>` + extraBlocks;
    } else {
      const bookExtra = active.extra.find(e => e.bookName === type);
      if (!bookExtra) return;
      titleLabel = `${prefix}${bookExtra.bookName} — Extra`;
      bodyHtml = `<h2 style="color:#7c3aed;font-size:16px;margin:0 0 12px;">📚 ${esc(bookExtra.bookName)} — Extra Points (${bookExtra.points.length})</h2><ul style="padding:0;margin:0;">${pointList(bookExtra.points, '#f5f3ff')}</ul>`;
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IIC · ${esc(titleLabel)}</title>
  <style>
    body { margin:0; padding:0; font-family:'Segoe UI',system-ui,sans-serif; background:#f1f5f9; color:#0f172a; font-size:14px; }
    .topbar { background:linear-gradient(135deg,#1e293b,#7c3aed); color:#fff; padding:14px 20px; display:flex; align-items:center; gap:14px; position:sticky; top:0; z-index:50; box-shadow:0 4px 12px rgba(0,0,0,0.2); }
    .logo { width:40px; height:40px; border-radius:12px; background:rgba(255,255,255,0.15); display:flex; align-items:center; justify-content:center; font-weight:900; font-size:18px; }
    .title-block { flex:1; }
    .app-label { font-size:11px; font-weight:800; letter-spacing:.2em; text-transform:uppercase; opacity:.8; margin:0; }
    .page-title { font-size:15px; font-weight:800; margin:2px 0 0; }
    .badge { font-size:10px; font-weight:800; background:rgba(255,215,0,0.25); color:#fde68a; padding:4px 10px; border-radius:999px; border:1px solid rgba(255,215,0,0.3); }
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
      <p class="app-label">IIC · Full Book Compare</p>
      <h1 class="page-title">${esc(titleLabel)}</h1>
    </div>
    <span class="badge">⭐ ULTRA</span>
  </div>
  <div class="subhead"><span>${esc(prefix || 'Full Compare')}</span><span>Saved on ${savedOn}</span></div>
  <div class="main"><div class="card">${bodyHtml}</div></div>
  <div class="footer">Saved from <strong>IIC</strong> — Full Book Compare.<br/>This is a static snapshot for offline reading.</div>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fullbook_${type.replace(/\s+/g, '_')}_${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  const paginate = (points: string[], page: number) => points.slice(page * POINTS_PER_PAGE, (page + 1) * POINTS_PER_PAGE);
  const totalPg = (points: string[]) => Math.max(1, Math.ceil(points.length / POINTS_PER_PAGE));
  const activeResult = topicResult ?? result;
  const activeExtraData = activeResult?.extra.find(e => e.bookName === activeExtraBook);
  const extraCurPage = extraPages[activeExtraBook ?? ''] ?? 0;

  // ── Highlight word in text ──
  const highlight = (text: string, word: string) => {
    if (!word || word.length < 2) return <>{text}</>;
    const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return (
      <>
        {parts.map((part, i) =>
          regex.test(part)
            ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">{part}</mark>
            : <span key={i}>{part}</span>
        )}
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-[250] bg-white flex flex-col overflow-hidden animate-in fade-in">
      {/* Header — hidden in focus mode */}
      {!isFocusMode && (
        <div className="bg-gradient-to-r from-slate-900 via-purple-900 to-slate-900 text-white px-4 py-3 flex items-center gap-3 shrink-0 shadow-xl">
          <div className="p-2 rounded-xl bg-white/10">
            <Crown size={18} className="text-yellow-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-black text-base leading-tight">Full Book Compare</h2>
              <span className="text-[9px] font-black bg-yellow-400 text-black px-2 py-0.5 rounded-full tracking-wide">ULTRA</span>
            </div>
            <p className="text-[11px] text-purple-200 truncate">
              {topicResult
                ? `"${topicResult.topicName}" · ${topicResult.common.length} common · ${topicResult.extra.reduce((a, e) => a + e.points.length, 0)} extra`
                : compreLoading
                  ? 'Notes load ho rahi hain…'
                  : `${bookContents.length} books ready — word search karein`}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-white/20 transition-colors shrink-0">
            <X size={20} />
          </button>
        </div>
      )}

      {/* ── TOPIC COMPARE breadcrumb + tabs — hidden in focus mode ── */}
      {!isFocusMode && topicResult && (
        <>
          <div className="flex items-center gap-2 px-3 pt-3 shrink-0">
            <button
              onClick={() => { setTopicResult(null); setTab('search'); }}
              className="flex items-center gap-1.5 text-[11px] font-black text-violet-600 bg-violet-50 border border-violet-200 px-3 py-1.5 rounded-full active:scale-95 transition-all"
            >
              <ChevronLeft size={13} /> Wapas
            </button>
            <span className="text-[12px] font-black text-slate-700 truncate">🔍 "{topicResult.topicName}"</span>
          </div>

          <div className="flex bg-slate-100 p-1 gap-1 shrink-0 mx-3 mt-2 rounded-xl">
            <button
              onClick={() => setTab('common')}
              className={`flex-1 py-2 text-[11px] font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${tab === 'common' ? 'bg-white shadow text-emerald-700' : 'text-slate-500'}`}
            >
              <CheckCircle2 size={12} /> Common ({topicResult.common.length})
            </button>
            <button
              onClick={() => setTab('extra')}
              className={`flex-1 py-2 text-[11px] font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${tab === 'extra' ? 'bg-white shadow text-violet-700' : 'text-slate-500'}`}
            >
              <BookOpen size={12} /> Extra ({topicResult.extra.reduce((a, e) => a + e.points.length, 0)})
            </button>
            <button
              onClick={() => setTab('download')}
              className={`flex-1 py-2 text-[11px] font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${tab === 'download' ? 'bg-white shadow text-blue-700' : 'text-slate-500'}`}
            >
              <Download size={12} /> Save
            </button>
          </div>
        </>
      )}

      {/* ══════ CONTENT AREA ══════ */}
      <div className="flex-1 overflow-y-auto pb-8">

        {/* ── WORD SEARCH VIEW ── */}
        {!topicResult && (
          <div className="px-3 pt-4 space-y-3">
            {/* Search bar */}
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchWord}
                onChange={e => setSearchWord(e.target.value)}
                placeholder="Koi bhi word likhein — sab books mein search hoga…"
                className="w-full pl-9 pr-4 py-3 border-2 border-violet-200 rounded-2xl text-sm font-semibold outline-none focus:border-violet-500 bg-violet-50 placeholder:text-slate-400 placeholder:font-normal"
                autoFocus
              />
              {searchWord && (
                <button
                  onClick={() => setSearchWord('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            {/* Subject filter pills */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
              {SUBJECT_FILTERS.map(sf => (
                <button
                  key={sf.id}
                  onClick={() => { setCompreSubject(sf.id); }}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-black border-2 transition-all ${compreSubject === sf.id ? 'bg-violet-600 text-white border-violet-600 shadow-md' : 'bg-white text-violet-600 border-violet-200 hover:border-violet-400'}`}
                >
                  {sf.label}
                </button>
              ))}
            </div>

            {/* Loading indicator */}
            {compreLoading && (
              <div className="flex items-center gap-2 px-2 text-[11px] text-indigo-500 font-semibold">
                <Loader2 size={13} className="animate-spin" />
                Compre Notes load ho rahi hain…
              </div>
            )}

            {/* Empty state — show saved topics list */}
            {!searchWord && (
              <div className="space-y-3">
                {compreLoading ? null : allCompreTopics.length > 0 ? (
                  <>
                    <div className="flex items-center justify-between px-1">
                      <p className="text-[11px] font-black text-violet-700 uppercase tracking-wider">
                        📚 Saved Topics ({allCompreTopics.length})
                      </p>
                      <p className="text-[10px] text-slate-400">Click karein → Compare dekhein</p>
                    </div>
                    <div className="space-y-2">
                      {allCompreTopics.map(topic => {
                        const cleanName = topic.topicName.replace(/^[\s📌📚🔹🔸▪•●\-\*→>\d]+\s*/, '').trim() || topic.topicName;
                        const dateStr = topic.createdAt ? new Date(topic.createdAt).toLocaleDateString('hi-IN', { day: '2-digit', month: 'short' }) : '';
                        return (
                          <button
                            key={topic.groupId || topic.topicName}
                            onClick={() => handleTopicSelect(topic.topicName, topic.groupId)}
                            className="w-full text-left bg-white border-2 border-violet-100 hover:border-violet-400 active:scale-[0.98] rounded-2xl px-4 py-3 transition-all shadow-sm group"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-black text-slate-800 leading-snug group-hover:text-violet-700 transition-colors truncate">
                                  {topic.topicName}
                                </p>
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {topic.books.map(b => (
                                    <span key={b} className="text-[10px] font-bold bg-violet-50 text-violet-600 border border-violet-200 px-2 py-0.5 rounded-full">
                                      {b}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className="shrink-0 flex flex-col items-end gap-1">
                                <span className="text-[10px] text-slate-400">{dateStr}</span>
                                <span className="text-[10px] font-black bg-violet-600 text-white px-2 py-0.5 rounded-full">
                                  {topic.books.length} book{topic.books.length !== 1 ? 's' : ''}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="pt-2 border-t border-slate-100">
                      <p className="text-[10px] text-slate-400 text-center">Ya upar search karein koi bhi word likhke</p>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-16 text-slate-400">
                    <Search size={48} className="mx-auto mb-4 opacity-20" />
                    <p className="font-black text-slate-500 text-base">Word Search</p>
                    <p className="text-xs mt-2 leading-relaxed text-slate-400">
                      Upar koi bhi word likhein.<br />
                      Jitne books mein wo word hoga — sab ke sab notes aur points dikh jaayenge.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                      {['Mughal', 'Congress', 'Photosynthesis', 'DNA', 'संविधान', 'Newton'].map(ex => (
                        <button
                          key={ex}
                          onClick={() => setSearchWord(ex)}
                          className="px-3 py-1.5 bg-violet-100 text-violet-700 rounded-full text-xs font-bold hover:bg-violet-200 transition-colors"
                        >
                          {ex}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Search too short */}
            {searchWord && searchWord.trim().length < 2 && (
              <p className="text-center text-xs text-slate-400 py-4">Kam se kam 2 characters likhein…</p>
            )}

            {/* No results */}
            {searchWord.trim().length >= 2 && wordSearchResults.length === 0 && !compreLoading && (
              <div className="text-center py-14 text-slate-400">
                <Search size={40} className="mx-auto mb-3 opacity-20" />
                <p className="font-black text-slate-500">"{searchWord}" nahi mila</p>
                <p className="text-xs mt-2">Is word ke notes kisi bhi book mein nahi hain. Dusra word try karein.</p>
              </div>
            )}

            {/* Results */}
            {wordSearchResults.length > 0 && (
              <>
                {/* Summary bar */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-[11px] font-black text-violet-700 uppercase tracking-wider">
                    {wordSearchResults.reduce((a, r) => a + r.points.length, 0)} points — {wordSearchResults.length} book{wordSearchResults.length !== 1 ? 's' : ''} mein mila
                  </p>
                  {wordSearchResults.length >= 2 && (
                    <button
                      onClick={openWordCompare}
                      className="flex items-center gap-1.5 bg-violet-600 text-white px-4 py-2 rounded-2xl text-xs font-black hover:bg-violet-700 active:scale-95 transition-all shadow-md"
                    >
                      <GitCompare size={13} /> Compare Books
                    </button>
                  )}
                </div>

                {/* Per-book results */}
                {wordSearchResults.map(res => (
                  <div key={res.bookName} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                    {/* Book header */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100">
                      <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center shrink-0">
                        <BookOpen size={15} className="text-violet-600" />
                      </div>
                      <p className="flex-1 text-sm font-black text-slate-800">{res.bookName}</p>
                      <span className="shrink-0 text-[11px] font-black bg-violet-600 text-white px-2.5 py-1 rounded-full">
                        {res.points.length} points
                      </span>
                    </div>

                    {/* Matching points */}
                    <div className="p-3 space-y-1.5">
                      {res.points.map((point, pi) => (
                        <div key={pi} className="flex items-start gap-2 text-xs text-slate-700 leading-relaxed py-1 border-b border-slate-50 last:border-0">
                          <span className="shrink-0 text-[10px] font-black text-violet-400 mt-0.5 w-5 text-right">{pi + 1}.</span>
                          <span>{highlight(point, searchWord.trim())}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ── COMMON TAB ── */}
        {tab === 'common' && topicResult && (
          <div className="px-3 pt-3 space-y-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3 flex items-center gap-3">
              <CheckCircle2 size={20} className="text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-black text-emerald-800">Common — "{topicResult.topicName}"</p>
                <p className="text-[10px] text-emerald-600">{topicResult.common.length} points jo sab books mein same hain</p>
              </div>
              <button onClick={() => handleDownload('common')} className="shrink-0 bg-emerald-600 text-white rounded-xl px-3 py-1.5 text-[10px] font-black flex items-center gap-1">
                <Download size={11} /> Save
              </button>
            </div>

            {topicResult.common.length === 0 ? (
              <div className="text-center py-14 text-slate-400">
                <GitCompare size={44} className="mx-auto mb-3 opacity-20" />
                <p className="font-black text-slate-500">Koi common point nahi mila</p>
                <p className="text-xs mt-2">Is word ke notes books mein kaafi alag hain — Extra tab dekhein</p>
              </div>
            ) : isLimited ? (
              <div className="relative">
                <ChunkedNotesReader
                  key="fbc-common-limited"
                  content={topicResult.common.slice(0, freeLimit).join('\n')}
                  topBarLabel={`"${topicResult.topicName}" Common — ${freeLimit} of ${topicResult.common.length}`}
                  language="hi-IN"
                />
                {topicResult.common.length > freeLimit && (
                  <div className="relative mt-2">
                    <div className="blur-sm pointer-events-none select-none opacity-40 text-xs text-slate-600 space-y-1 px-1">
                      {topicResult.common.slice(freeLimit, freeLimit + 3).map((p, i) => <p key={i}>• {p.substring(0, 80)}…</p>)}
                    </div>
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl px-4 py-5">
                      <Crown size={28} className="text-yellow-500 mb-2" />
                      <p className="font-black text-slate-800 text-sm text-center">{topicResult.common.length - freeLimit} aur points hain</p>
                      <p className="text-[11px] text-slate-500 text-center mt-1">ULTRA mein poore {topicResult.common.length} common points dekho</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <ChunkedNotesReader
                  key={`fbc-common-${commonPage}`}
                  content={paginate(topicResult.common, commonPage).join('\n')}
                  topBarLabel={`"${topicResult.topicName}" Common — Page ${commonPage + 1} of ${totalPg(topicResult.common)}`}
                  language="hi-IN"
                />
                {totalPg(topicResult.common) > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <button disabled={commonPage === 0} onClick={() => setCommonPage(p => p - 1)} className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-emerald-100 text-emerald-700 font-black text-xs disabled:opacity-30 active:scale-95 transition-all">
                      <ChevronLeft size={14} /> Prev
                    </button>
                    <span className="text-xs font-bold text-slate-500">{commonPage + 1} / {totalPg(topicResult.common)}</span>
                    <button disabled={commonPage >= totalPg(topicResult.common) - 1} onClick={() => setCommonPage(p => p + 1)} className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-emerald-100 text-emerald-700 font-black text-xs disabled:opacity-30 active:scale-95 transition-all">
                      Next <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── EXTRA TAB ── */}
        {tab === 'extra' && topicResult && (
          <div className="px-3 pt-3 space-y-3">
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
              {topicResult.extra.filter(({ points }) => points.length > 0).map(({ bookName, points }) => (
                <button
                  key={bookName}
                  onClick={() => { setActiveExtraBook(bookName); setExtraPages(prev => ({ ...prev, [bookName]: 0 })); }}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-2xl text-[11px] font-black border-2 transition-all ${activeExtraBook === bookName ? 'bg-violet-600 text-white border-violet-600 shadow-md' : 'bg-white text-violet-700 border-violet-200 hover:border-violet-400'}`}
                >
                  📚 {bookName}
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${activeExtraBook === bookName ? 'bg-white/20' : 'bg-violet-100'}`}>{points.length}</span>
                </button>
              ))}
            </div>

            {activeExtraData && (
              <>
                <div className="bg-violet-50 border border-violet-200 rounded-2xl px-4 py-3 flex items-center gap-3">
                  <BookOpen size={18} className="text-violet-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-violet-800">{activeExtraData.bookName}</p>
                    <p className="text-[10px] text-violet-500">{activeExtraData.points.length} extra — sirf is book mein</p>
                  </div>
                  <button onClick={() => handleDownload(activeExtraData.bookName)} className="shrink-0 bg-violet-600 text-white rounded-xl px-3 py-1.5 text-[10px] font-black flex items-center gap-1">
                    <Download size={11} /> Save
                  </button>
                </div>

                {activeExtraData.points.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <CheckCircle2 size={36} className="mx-auto mb-2 text-emerald-400" />
                    <p className="font-black text-slate-500">Is book ke sab points common hain!</p>
                  </div>
                ) : isLimited ? (
                  <div className="relative">
                    <ChunkedNotesReader
                      key={`fbc-extra-limited-${activeExtraBook}`}
                      content={activeExtraData.points.slice(0, freeLimit).join('\n')}
                      topBarLabel={`${activeExtraData.bookName} Extra — ${freeLimit} of ${activeExtraData.points.length}`}
                      language="hi-IN"
                    />
                    {activeExtraData.points.length > freeLimit && (
                      <div className="relative mt-2">
                        <div className="blur-sm pointer-events-none select-none opacity-40 text-xs text-slate-600 space-y-1 px-1">
                          {activeExtraData.points.slice(freeLimit, freeLimit + 3).map((p, i) => <p key={i}>• {p.substring(0, 80)}…</p>)}
                        </div>
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl px-4 py-5">
                          <Crown size={28} className="text-yellow-500 mb-2" />
                          <p className="font-black text-slate-800 text-sm text-center">{activeExtraData.points.length - freeLimit} aur points hain</p>
                          <p className="text-[11px] text-slate-500 text-center mt-1">ULTRA mein poore {activeExtraData.points.length} extra points dekho</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <ChunkedNotesReader
                      key={`fbc-extra-${activeExtraBook}-${extraCurPage}`}
                      content={paginate(activeExtraData.points, extraCurPage).join('\n')}
                      topBarLabel={`${activeExtraData.bookName} Extra — Page ${extraCurPage + 1} of ${totalPg(activeExtraData.points)}`}
                      language="hi-IN"
                    />
                    {totalPg(activeExtraData.points) > 1 && (
                      <div className="flex items-center justify-between pt-2">
                        <button disabled={extraCurPage === 0} onClick={() => setExtraPages(prev => ({ ...prev, [activeExtraBook!]: extraCurPage - 1 }))} className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-violet-100 text-violet-700 font-black text-xs disabled:opacity-30 active:scale-95 transition-all">
                          <ChevronLeft size={14} /> Prev
                        </button>
                        <span className="text-xs font-bold text-slate-500">{extraCurPage + 1} / {totalPg(activeExtraData.points)}</span>
                        <button disabled={extraCurPage >= totalPg(activeExtraData.points) - 1} onClick={() => setExtraPages(prev => ({ ...prev, [activeExtraBook!]: extraCurPage + 1 }))} className="flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-violet-100 text-violet-700 font-black text-xs disabled:opacity-30 active:scale-95 transition-all">
                          Next <ChevronRight size={14} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* ── DOWNLOAD TAB ── */}
        {tab === 'download' && activeResult && topicResult && (
          <div className="px-3 pt-3 space-y-3">
            <p className="text-[11px] text-slate-500 font-semibold px-1">
              "{topicResult.topicName}" — alag-alag ya ek saath download karein
            </p>
            <button onClick={() => handleDownload('all')} className="w-full bg-gradient-to-r from-slate-900 to-purple-900 text-white py-3.5 rounded-2xl text-sm font-black flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg">
              <Download size={16} /> Sab Ek Saath Download
              <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full">Common + Sab Extra</span>
            </button>
            <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-black text-emerald-800">✅ Common Points</p>
                  <p className="text-[10px] text-emerald-600">{activeResult.common.length} points jo sab books mein hain</p>
                </div>
                <span className="text-2xl font-black text-emerald-600">{activeResult.common.length}</span>
              </div>
              <button onClick={() => handleDownload('common')} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all">
                <Download size={13} /> Common Points Download
              </button>
            </div>
            {topicResult.extra.filter(({ points }) => points.length > 0).map(({ bookName, points }) => (
              <div key={bookName} className="bg-violet-50 border-2 border-violet-200 rounded-2xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-black text-violet-800">📚 {bookName}</p>
                    <p className="text-[10px] text-violet-500">{points.length} extra points sirf is book mein</p>
                  </div>
                  <span className="text-2xl font-black text-violet-500">{points.length}</span>
                </div>
                <button onClick={() => handleDownload(bookName)} className="w-full bg-violet-600 hover:bg-violet-700 text-white py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all">
                  <Download size={13} /> {bookName} — Extra Download
                </button>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
};
