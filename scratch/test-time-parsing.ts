function getSlotMatchingPatterns(startTime: string | Date): RegExp[] {
  const d = new Date(startTime);
  const patterns: RegExp[] = [];

  const numberWords: Record<number, string> = {
    1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
    6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
    11: 'eleven', 12: 'twelve'
  };
  const minuteWords: Record<number, string> = {
    0: "o'?clock",
    15: 'fifteen',
    30: 'thirty',
    45: 'forty[ -]?five'
  };

  // Add patterns for both local time and UTC time
  const timeVariants = [
    { hour24: d.getHours(), min: d.getMinutes() },
    { hour24: d.getUTCHours(), min: d.getUTCMinutes() }
  ];

  for (const { hour24, min } of timeVariants) {
    const hour12 = hour24 % 12 || 12;
    const minStr = min < 10 ? `0${min}` : `${min}`;
    const hourWord = numberWords[hour12];
    const minWord = minuteWords[min];

    patterns.push(new RegExp(`\\b${hour12}:${minStr}\\b`, 'i'));
    patterns.push(new RegExp(`\\b${hour12}\\s+${minStr}\\b`, 'i'));
    patterns.push(new RegExp(`\\b${hour24}:${minStr}\\b`, 'i'));

    if (min === 0) {
      patterns.push(new RegExp(`\\b${hour12}\\s*(?:am|pm|o'?clock)\\b`, 'i'));
      if (hourWord) {
        patterns.push(new RegExp(`\\b${hourWord}\\s*(?:am|pm|o'?clock)\\b`, 'i'));
      }
    } else {
      patterns.push(new RegExp(`\\b${hour12}\\s*${minStr}\\s*(?:am|pm)?\\b`, 'i'));
      if (hourWord && minWord) {
        patterns.push(new RegExp(`\\b${hourWord}\\s+${minWord}\\b`, 'i'));
      }
    }
  }

  return patterns;
}

function extractTimeMention(text: string): string | null {
  const m =
    text.match(/\b(\d{1,2}\s*:\s*\d{2}\s*(?:am|pm)?)\b/i) ||
    text.match(/\b(\d{1,2}\s+\d{2}\s*(?:am|pm)?)\b/i) ||
    text.match(/\b((?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:thirty|fifteen|forty[ -]?five|o'?clock)(?:\s*(?:am|pm))?)\b/i) ||
    text.match(/\b(\d{1,2}\s*(?:am|pm|o'?clock))\b/i) ||
    text.match(/\b(?:at|for|the)\s+(\d{1,2})\s*(?:one|am|pm)?\b/i);

  return m ? m[1].trim() : null;
}

const testSlots = [
  { id: 'slot-930', startTime: '2026-09-28T09:30:00.000Z' }, // 9:30 AM (UTC)
  { id: 'slot-1030', startTime: '2026-09-28T10:30:00.000Z' }, // 10:30 AM (UTC)
  { id: 'slot-1400', startTime: '2026-09-28T14:00:00.000Z' }, // 2:00 PM (UTC)
];

const testPhrasings = [
  "book the 10 30 AM slot",
  "book the 10 30 slot",
  "ten thirty",
  "ten thirty am",
  "10:30",
  "10:30 AM",
  "please book nine thirty",
  "9:30 am",
  "9 30",
  "2pm",
  "two o'clock"
];

console.log('=== TESTING TIME PARSING AND SLOT MATCHING (UTC + Local) ===');
for (const phrase of testPhrasings) {
  const extracted = extractTimeMention(phrase);
  let matchedSlot: any = null;
  for (const slot of testSlots) {
    const patterns = getSlotMatchingPatterns(slot.startTime);
    if (patterns.some(p => p.test(phrase))) {
      matchedSlot = slot;
      break;
    }
  }
  console.log(`Input: "${phrase}" -> Extracted: "${extracted}" -> Matched: ${matchedSlot ? matchedSlot.id : 'NONE'}`);
}
