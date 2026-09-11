/**
 * The family mascots — drawn from the photos of the two kids rather than
 * generated, so they stay editable: every colour below is a knob, and a new
 * sibling is a new palette plus a hair shape.
 *
 * Keep the white mittens' outline. On a white card a pure-white hand
 * disappears completely, which is how they were lost the first time.
 */

export type MascotWho = 'boy' | 'girl';
export type MascotMood = 'happy' | 'wave' | 'cheer' | 'sleepy';

const PALETTE = {
  boy: {
    hair: '#1f1f27',
    skin: '#f3caa2',
    skinShade: '#e3b78f',
    jacket: '#2c3f5c',
    jacketDark: '#1f2d43',
    jacketLine: '#405a80',
    mitten: '#fcfcfc',
    pants: '#33363f',
    shoe: '#9aa1ab',
    sole: '#eceef1',
  },
  girl: {
    hair: '#1f1f27',
    skin: '#f7d1aa',
    skinShade: '#e8bb93',
    jacket: '#e8bbdc',
    jacketDark: '#d5a1cb',
    jacketLine: '#f2d2e9',
    mitten: '#fcfcfc',
    skirt: '#fdf5f0',
    skirtShade: '#f0e0d5',
    boot: '#2e2e35',
    scarf: '#f4bb90',
    scarfAlt: '#fdf1e4',
    tie: '#f28fb0',
  },
} as const;

function Face({ mood }: { mood: MascotMood }) {
  const closed = mood === 'cheer' || mood === 'sleepy';
  const lidY = mood === 'cheer' ? 79 : 95;

  return (
    <>
      <ellipse cx="70" cy="96" rx="8" ry="5" fill="#f4a3b4" opacity="0.5" />
      <ellipse cx="130" cy="96" rx="8" ry="5" fill="#f4a3b4" opacity="0.5" />

      {closed ? (
        <>
          <path
            d={`M77 88 Q85 ${lidY} 93 88`}
            stroke="#2b2b33"
            strokeWidth="3.4"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M107 88 Q115 ${lidY} 123 88`}
            stroke="#2b2b33"
            strokeWidth="3.4"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <ellipse cx="85" cy="87" rx="5.4" ry="7" fill="#2b2b33" />
          <ellipse cx="115" cy="87" rx="5.4" ry="7" fill="#2b2b33" />
          <circle cx="87" cy="84" r="1.9" fill="#fff" />
          <circle cx="117" cy="84" r="1.9" fill="#fff" />
        </>
      )}

      {mood === 'cheer' ? (
        <path d="M92 98 Q100 110 108 98 Z" fill="#c9566b" />
      ) : mood === 'sleepy' ? (
        <ellipse cx="100" cy="101" rx="4" ry="5" fill="#c9566b" />
      ) : (
        <path
          d="M92 99 Q100 106 108 99"
          stroke="#a4564a"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      )}

      {mood === 'sleepy' && (
        <>
          <text x="150" y="52" fontSize="16" fill="#9aa1ab">
            z
          </text>
          <text x="163" y="40" fontSize="11" fill="#b6bcc4">
            z
          </text>
        </>
      )}
    </>
  );
}

function Arms({ mood, sleeve, mitten }: { mood: MascotMood; sleeve: string; mitten: string }) {
  const hand = (cx: number, cy: number) => (
    <circle cx={cx} cy={cy} r="10" fill={mitten} stroke="#d9d2cc" strokeWidth="1.6" />
  );

  const upLeft = (
    <>
      <path d="M70 132 Q48 120 44 96" stroke={sleeve} strokeWidth="17" fill="none" strokeLinecap="round" />
      {hand(43, 91)}
    </>
  );
  const upRight = (
    <>
      <path d="M130 132 Q152 120 156 96" stroke={sleeve} strokeWidth="17" fill="none" strokeLinecap="round" />
      {hand(157, 91)}
    </>
  );
  const downLeft = (
    <>
      <path d="M74 128 Q52 146 50 170" stroke={sleeve} strokeWidth="17" fill="none" strokeLinecap="round" />
      {hand(50, 176)}
    </>
  );
  const downRight = (
    <>
      <path d="M126 128 Q148 146 150 170" stroke={sleeve} strokeWidth="17" fill="none" strokeLinecap="round" />
      {hand(150, 176)}
    </>
  );

  if (mood === 'cheer') {
    return (
      <>
        {upLeft}
        {upRight}
      </>
    );
  }
  if (mood === 'wave') {
    return (
      <>
        {downLeft}
        {upRight}
      </>
    );
  }
  return (
    <>
      {downLeft}
      {downRight}
    </>
  );
}

function Boy({ mood }: { mood: MascotMood }) {
  const p = PALETTE.boy;
  return (
    <>
      <ellipse cx="100" cy="128" rx="42" ry="17" fill={p.jacketDark} />
      <path
        d="M64 130 Q64 116 82 112 L118 112 Q136 116 136 130 L139 192 Q139 204 124 205 L76 205 Q61 204 61 192 Z"
        fill={p.jacket}
      />
      <path
        d="M68 146 H132 M66 164 H134 M65 182 H135"
        stroke={p.jacketLine}
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.75"
      />
      <path d="M100 114 V203" stroke={p.jacketDark} strokeWidth="3" />
      <Arms mood={mood} sleeve={p.jacket} mitten={p.mitten} />

      <rect x="80" y="200" width="16" height="34" rx="7" fill={p.pants} />
      <rect x="104" y="200" width="16" height="34" rx="7" fill={p.pants} />
      <path d="M74 232 h24 a6 6 0 0 1 6 6 v4 h-36 v-4 a6 6 0 0 1 6 -6z" fill={p.shoe} />
      <path d="M102 232 h24 a6 6 0 0 1 6 6 v4 h-36 v-4 a6 6 0 0 1 6 -6z" fill={p.shoe} />
      <rect x="68" y="240" width="36" height="5" rx="2.5" fill={p.sole} />
      <rect x="96" y="240" width="36" height="5" rx="2.5" fill={p.sole} />

      <circle cx="60" cy="84" r="7" fill={p.skinShade} />
      <circle cx="140" cy="84" r="7" fill={p.skinShade} />
      <ellipse cx="100" cy="80" rx="42" ry="40" fill={p.skin} />

      <path d="M72 44 L80 22 L93 42 Z" fill={p.hair} />
      <path d="M92 40 L104 18 L116 44 Z" fill={p.hair} />
      <path d="M114 46 L129 28 L133 52 Z" fill={p.hair} />
      <path
        d="M58 80 C58 50 77 38 100 38 C123 38 142 50 142 80
           C142 72 138 66 131 64 C124 62 120 70 113 66
           C106 62 104 70 96 66 C88 62 83 70 75 66 C67 62 61 70 58 80 Z"
        fill={p.hair}
      />
      <Face mood={mood} />
    </>
  );
}

function Girl({ mood }: { mood: MascotMood }) {
  const p = PALETTE.girl;
  return (
    <>
      <ellipse cx="46" cy="76" rx="17" ry="26" fill={p.hair} />
      <ellipse cx="154" cy="76" rx="17" ry="26" fill={p.hair} />
      <ellipse cx="100" cy="128" rx="40" ry="16" fill={p.jacketDark} />

      <path d="M72 168 L128 168 L140 216 Q100 228 60 216 Z" fill={p.skirt} />
      <path d="M72 168 L128 168 L132 190 Q100 197 68 190 Z" fill={p.skirtShade} opacity="0.5" />
      <rect x="84" y="214" width="13" height="20" rx="6" fill={p.skin} />
      <rect x="103" y="214" width="13" height="20" rx="6" fill={p.skin} />
      <path d="M80 232 h21 a5 5 0 0 1 5 5 v7 h-31 v-7 a5 5 0 0 1 5 -5z" fill={p.boot} />
      <path d="M99 232 h21 a5 5 0 0 1 5 5 v7 h-31 v-7 a5 5 0 0 1 5 -5z" fill={p.boot} />

      <path
        d="M66 130 Q66 116 83 112 L117 112 Q134 116 134 130 L136 166 Q136 178 122 179 L78 179 Q64 178 64 166 Z"
        fill={p.jacket}
      />
      <path
        d="M70 146 H130 M69 162 H131"
        stroke={p.jacketLine}
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.8"
      />
      <path d="M100 114 V177" stroke={p.jacketDark} strokeWidth="3" />
      <Arms mood={mood} sleeve={p.jacket} mitten={p.mitten} />

      <path d="M70 126 Q100 148 130 126 Q132 114 100 116 Q68 114 70 126 Z" fill={p.scarf} />
      <path
        d="M80 128 h9 M96 134 h9 M111 128 h9"
        stroke={p.scarfAlt}
        strokeWidth="3.4"
        strokeLinecap="round"
      />

      <circle cx="60" cy="84" r="7" fill={p.skinShade} />
      <circle cx="140" cy="84" r="7" fill={p.skinShade} />
      <ellipse cx="100" cy="80" rx="42" ry="40" fill={p.skin} />

      <path
        d="M56 78 C56 46 76 34 100 34 C124 34 144 46 144 78
           L144 60 Q122 72 100 68 Q78 64 56 74 Z"
        fill={p.hair}
      />
      <path
        d="M56 74 Q78 62 100 68 Q122 74 144 60 L144 72 Q120 84 100 78 Q80 72 56 82 Z"
        fill={p.hair}
      />
      <circle cx="52" cy="54" r="7" fill={p.tie} />
      <circle cx="148" cy="54" r="7" fill={p.tie} />
      <Face mood={mood} />
    </>
  );
}

export function Mascot({
  who,
  mood = 'happy',
  size = 140,
}: {
  who: MascotWho;
  mood?: MascotMood;
  size?: number;
}) {
  return (
    <svg viewBox="0 0 200 260" width={size} height={(size * 260) / 200} role="img" aria-hidden="true">
      {who === 'boy' ? <Boy mood={mood} /> : <Girl mood={mood} />}
    </svg>
  );
}

/**
 * Which mascot greets you, and how, depending on what the board looks like —
 * the app feels alive when the character reacts instead of always smiling.
 */
export function moodForDay(opts: { openTasks: number; doneToday: number; hour: number }): MascotMood {
  if (opts.hour >= 21 || opts.hour < 6) return 'sleepy';
  if (opts.doneToday > 0 && opts.openTasks === 0) return 'cheer';
  if (opts.doneToday > 0) return 'wave';
  return 'happy';
}
