import React from 'react';
import { ClassLevel, Subject, Stream, Board, SystemSettings, LucentNoteEntry } from '../types';
import { getSubjectsList } from '../constants';
import { Calculator, FlaskConical, Languages, Globe2, BookMarked, History, TrendingUp, Briefcase, Landmark, Feather, Home, HeartPulse, Activity, Cpu, ChevronRight } from 'lucide-react';
import type { ContentIndexMap } from '../firebase';

interface Props {
  classLevel: ClassLevel;
  stream: Stream | null;
  board?: Board;
  onSelect: (subject: Subject) => void;
  onBack: () => void;
  hideBack?: boolean;
  initialParentSubject?: string | null;
  settings?: SystemSettings | null;
  contentIndex?: ContentIndexMap;
  lucentNotes?: LucentNoteEntry[];
}

const SubjectIcon: React.FC<{ icon: string; className?: string }> = ({ icon, className }) => {
  switch (icon) {
    case 'math':     return <Calculator className={className} />;
    case 'science':
    case 'physics':
    case 'flask':    return <FlaskConical className={className} />;
    case 'bio':      return <HeartPulse className={className} />;
    case 'english':
    case 'hindi':
    case 'sanskrit':
    case 'book':     return <Languages className={className} />;
    case 'social':
    case 'geo':      return <Globe2 className={className} />;
    case 'computer': return <Cpu className={className} />;
    case 'history':  return <History className={className} />;
    case 'accounts': return <TrendingUp className={className} />;
    case 'business': return <Briefcase className={className} />;
    case 'gov':      return <Landmark className={className} />;
    case 'ppl':      return <BookMarked className={className} />;
    case 'mind':     return <Feather className={className} />;
    case 'home':     return <Home className={className} />;
    case 'active':   return <Activity className={className} />;
    default:         return <BookMarked className={className} />;
  }
};

interface SubjectStats { notes: number; pdf: number; video: number; audio: number; mcq: number; lucentNotes: number; }

const getSubjectStats = (
  subject: Subject,
  classLevel: string,
  board: string,
  contentIndex: ContentIndexMap,
  lucentNotes: LucentNoteEntry[]
): SubjectStats => {
  const prefix = `nst_content_${board}_${classLevel}_`;
  const subjectNameLower = subject.name.toLowerCase().replace(/\s+/g, '_');
  let notes = 0, pdf = 0, video = 0, audio = 0, mcq = 0;

  Object.entries(contentIndex).forEach(([key, entry]) => {
    if (!key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length); // e.g. "Physics_ch1"
    const restLower = rest.toLowerCase();
    const storedSubject = (entry.subject || '').toLowerCase().replace(/\s+/g, '_');
    if (!storedSubject && !restLower.startsWith(subjectNameLower + '_')) return;
    if (storedSubject && storedSubject !== subjectNameLower) return;
    if (entry.notes)  notes++;
    if (entry.pdf)    pdf++;
    if (entry.video)  video++;
    if (entry.audio)  audio++;
    if (entry.mcq)    mcq++;
  });

  const lucentCount = lucentNotes.filter(n => {
    const nClass = n.classLevel || 'COMPETITION';
    return nClass === classLevel && (n.subject || '').toLowerCase() === subject.id.toLowerCase();
  }).length;

  return { notes, pdf, video, audio, mcq, lucentNotes: lucentCount };
};

export const SubjectSelection: React.FC<Props> = ({
  classLevel, stream, board, onSelect, onBack, hideBack = false, settings,
  contentIndex = {}, lucentNotes = []
}) => {
  const subjects = getSubjectsList(classLevel, stream, board).filter(
    sub => !(settings?.hiddenSubjects || []).includes(sub.id)
  );
  const currentBoard = board || 'CBSE';

  return (
    <div className="animate-in fade-in slide-in-from-right-8 duration-500 mt-0 pt-0">
      {!hideBack && (
        <div className="flex items-center mb-6">
          <button onClick={onBack} className="text-slate-600 hover:text-slate-800 transition-colors mr-4">
            &larr; Back
          </button>
          <div>
            <h2 className="text-2xl font-bold text-slate-800">
              {stream ? `${stream} Subjects` : `Class ${classLevel} Subjects`}
            </h2>
            <p className="text-slate-600 text-sm">Select a subject to view chapters</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {subjects.map((subject) => {
          const colorParts = (subject.color || 'bg-slate-50 text-slate-600').split(' ');
          const bgClass   = colorParts[0] || 'bg-slate-50';
          const textClass = colorParts[1] || 'text-slate-600';
          const borderClass = bgClass.replace('bg-', 'border-').replace('50', '200').replace('100', '300');
          const stats = getSubjectStats(subject, classLevel, currentBoard, contentIndex, lucentNotes);
          const totalContent = stats.notes + stats.pdf + stats.video + stats.audio + stats.mcq + stats.lucentNotes;

          const statBadges: { emoji: string; count: number; color: string }[] = [
            { emoji: '📝', count: stats.notes + stats.lucentNotes, color: 'text-indigo-600' },
            { emoji: '📄', count: stats.pdf,   color: 'text-rose-600' },
            { emoji: '📊', count: stats.mcq,   color: 'text-amber-600' },
            { emoji: '🎥', count: stats.video, color: 'text-green-600' },
            { emoji: '🔊', count: stats.audio, color: 'text-purple-600' },
          ].filter(b => b.count > 0);

          return (
            <button
              key={subject.id}
              onClick={() => onSelect(subject)}
              className={`${bgClass} border-2 ${borderClass} p-4 rounded-2xl flex items-center gap-4 hover:shadow-md transition-all active:scale-95 text-left group`}
            >
              <div className={`w-12 h-12 rounded-xl ${subject.color} flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform`}>
                <SubjectIcon icon={subject.icon} className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className={`font-black text-base ${textClass} truncate`}>{subject.name}</h3>
                {totalContent > 0 ? (
                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                    {statBadges.map(b => (
                      <span key={b.emoji} className={`text-[10px] font-bold ${b.color}`}>{b.emoji}{b.count}</span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 font-medium mt-0.5">No content yet</p>
                )}
              </div>
              <ChevronRight size={18} className={`${textClass} opacity-60 shrink-0`} />
            </button>
          );
        })}
      </div>
    </div>
  );
};
