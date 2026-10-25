// Turns sentence text into what the voice should say: the user's pronunciation list first,
// then subscripts, Greek letters, units, symbols and acronyms, and Hindi numbers in Hindi sentences.
// Only speech changes; the text and underline on screen stay as they are.

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}]';

const GREEK = {
    en: {
        α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'theta',
        ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', µ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma',
        ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
        Α: 'alpha', Β: 'beta', Γ: 'gamma', Δ: 'delta', Ε: 'epsilon', Ζ: 'zeta', Η: 'eta', Θ: 'theta', Ι: 'iota', Κ: 'kappa',
        Λ: 'lambda', Μ: 'mu', Ν: 'nu', Ξ: 'xi', Ο: 'omicron', Π: 'pi', Ρ: 'rho', Σ: 'sigma', Τ: 'tau', Υ: 'upsilon',
        Φ: 'phi', Χ: 'chi', Ψ: 'psi', Ω: 'omega',
    },
    hi: {
        α: 'अल्फ़ा', β: 'बीटा', γ: 'गामा', δ: 'डेल्टा', ε: 'एप्सिलॉन', ϵ: 'एप्सिलॉन', ζ: 'ज़ीटा', η: 'ईटा', θ: 'थीटा', ϑ: 'थीटा',
        ι: 'आयोटा', κ: 'कप्पा', λ: 'लैम्ब्डा', μ: 'म्यू', µ: 'म्यू', ν: 'न्यू', ξ: 'ज़ाई', ο: 'ओमिक्रॉन', π: 'पाई', ρ: 'रो', σ: 'सिग्मा',
        ς: 'सिग्मा', τ: 'टाउ', υ: 'अप्सिलॉन', φ: 'फ़ाई', ϕ: 'फ़ाई', χ: 'काई', ψ: 'साई', ω: 'ओमेगा',
        Α: 'अल्फ़ा', Β: 'बीटा', Γ: 'गामा', Δ: 'डेल्टा', Ε: 'एप्सिलॉन', Ζ: 'ज़ीटा', Η: 'ईटा', Θ: 'थीटा', Ι: 'आयोटा', Κ: 'कप्पा',
        Λ: 'लैम्ब्डा', Μ: 'म्यू', Ν: 'न्यू', Ξ: 'ज़ाई', Ο: 'ओमिक्रॉन', Π: 'पाई', Ρ: 'रो', Σ: 'सिग्मा', Τ: 'टाउ', Υ: 'अप्सिलॉन',
        Φ: 'फ़ाई', Χ: 'काई', Ψ: 'साई', Ω: 'ओमेगा',
    },
};

// Unit after a number: [English singular, English plural, Hindi].
const UNITS = {
    km: ['kilometre', 'kilometres', 'किलोमीटर'], cm: ['centimetre', 'centimetres', 'सेंटीमीटर'],
    mm: ['millimetre', 'millimetres', 'मिलीमीटर'], m: ['metre', 'metres', 'मीटर'],
    kg: ['kilogram', 'kilograms', 'किलोग्राम'], g: ['gram', 'grams', 'ग्राम'],
    GHz: ['gigahertz', 'gigahertz', 'गीगाहर्ट्ज़'], MHz: ['megahertz', 'megahertz', 'मेगाहर्ट्ज़'],
    kHz: ['kilohertz', 'kilohertz', 'किलोहर्ट्ज़'], Hz: ['hertz', 'hertz', 'हर्ट्ज़'],
    Mbps: ['megabit per second', 'megabits per second', 'मेगाबिट्स प्रति सेकंड'],
    kbps: ['kilobit per second', 'kilobits per second', 'किलोबिट्स प्रति सेकंड'],
    bps: ['bit per second', 'bits per second', 'बिट्स प्रति सेकंड'],
    kV: ['kilovolt', 'kilovolts', 'किलोवोल्ट'], mV: ['millivolt', 'millivolts', 'मिलीवोल्ट'], V: ['volt', 'volts', 'वोल्ट'],
    mA: ['milliampere', 'milliamperes', 'मिलीएम्पियर'], kW: ['kilowatt', 'kilowatts', 'किलोवाट'], W: ['watt', 'watts', 'वाट'],
    ms: ['millisecond', 'milliseconds', 'मिलीसेकंड'], µs: ['microsecond', 'microseconds', 'माइक्रोसेकंड'],
    us: ['microsecond', 'microseconds', 'माइक्रोसेकंड'], ns: ['nanosecond', 'nanoseconds', 'नैनोसेकंड'],
    GB: ['gigabyte', 'gigabytes', 'गीगाबाइट'], MB: ['megabyte', 'megabytes', 'मेगाबाइट'],
    KB: ['kilobyte', 'kilobytes', 'किलोबाइट'], kB: ['kilobyte', 'kilobytes', 'किलोबाइट'],
};
const UNIT_PATTERN = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s?(${Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|')})(?!${WORD_CHAR})`, 'gu');

const SYMBOLS = {
    en: { '=': 'equals', '≠': 'not equal to', '≈': 'approximately', '≤': 'less than or equal to', '≥': 'greater than or equal to',
        '±': 'plus or minus', '×': 'times', '→': 'to', '%': 'percent', '∞': 'infinity', '√': 'square root of' },
    hi: { '=': 'बराबर', '≠': 'बराबर नहीं', '≈': 'लगभग', '≤': 'से कम या बराबर', '≥': 'से अधिक या बराबर',
        '±': 'धन या ऋण', '×': 'गुणा', '→': 'से', '%': 'प्रतिशत', '∞': 'अनंत', '√': 'वर्गमूल' },
};
const SPACED_SYMBOLS = {
    en: { '·': 'times', '⋅': 'times', '<': 'less than', '>': 'greater than' },
    hi: { '·': 'गुणा', '⋅': 'गुणा', '<': 'से कम', '>': 'से अधिक' },
};
const DEGREES = {
    en: { '°C': 'degrees Celsius', '°F': 'degrees Fahrenheit', '°': 'degrees' },
    hi: { '°C': 'डिग्री सेल्सियस', '°F': 'डिग्री फ़ारेनहाइट', '°': 'डिग्री' },
};

const HINDI_0_TO_99 = (
    'शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस ' +
    'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस ' +
    'चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ ' +
    'साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी ' +
    'अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'
).split(' ');

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Indian number names: करोड़ (10⁷), लाख (10⁵), हज़ार, सौ.
export function hindiNumber(value) {
    if (value < 100) return HINDI_0_TO_99[value];
    const parts = [];
    for (const [size, name] of [[1e7, 'करोड़'], [1e5, 'लाख'], [1e3, 'हज़ार'], [100, 'सौ']]) {
        const count = Math.floor(value / size);
        if (count) parts.push(`${hindiNumber(count)} ${name}`);
        value %= size;
    }
    if (value) parts.push(HINDI_0_TO_99[value]);
    return parts.join(' ');
}

function hindiDigits(digits) {
    return [...digits].map((digit) => HINDI_0_TO_99[Number(digit)]).join(' ');
}

function sayHindiNumber(match) {
    const [whole, fraction] = match.split('.');
    // Very long numbers (phone numbers, IDs) are clearer digit by digit.
    const spokenWhole = whole.length > 9 ? hindiDigits(whole) : hindiNumber(Number(whole));
    return fraction ? `${spokenWhole} दशमलव ${hindiDigits(fraction)}` : spokenWhole;
}

// Ordinary words that often appear in capitals in headings ("NOTE TO STUDENTS").
const CAPITAL_WORDS = new Set(('A AN AND ARE AS AT BE BY FOR FROM HAS IF IN IS IT NO NOT OF ON OR THE TO WITH ' +
    'ALL ANY EACH NOTE PAGE PART PLEASE TEST EXAM MARKS TIME DATE NAME YEAR TOTAL ONLY ONE TWO').split(' '));

function isAcronym(token, inHeading) {
    const letters = (token.match(/[A-Z]/g) || []).length;
    const digits = token.length - letters;
    if (digits && letters) return true;
    if (letters < 2 || CAPITAL_WORDS.has(token)) return false;
    // In an all-capitals heading most words are ordinary words; spell only vowel-less ones like "PWM".
    return !inHeading || !/[AEIOU]/.test(token);
}

// lexicon: [{ word, say }] for this sentence's language.
export function speakable(text, lang, lexicon = []) {
    const language = lang === 'hi' ? 'hi' : 'en';
    const protectedSay = [];
    let result = text;

    // User entries win over every rule below, so swap them for placeholders the rules can't touch.
    const entries = lexicon.filter((entry) => entry.word && entry.word.trim()).sort((a, b) => b.word.length - a.word.length);
    for (const entry of entries) {
        const pattern = new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(entry.word.trim())}(?!${WORD_CHAR})`, 'giu');
        result = result.replace(pattern, () => {
            protectedSay.push(entry.say);
            return `${String.fromCharCode(0xE100 + protectedSay.length - 1)}`;
        });
    }

    result = result.replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966));
    result = result.replace(/[₀-₉]+/g, (run) => ` ${[...run].map((c) => SUBSCRIPTS.indexOf(c)).join('')} `);
    result = result.replace(/[⁰¹²³⁴-⁹]+/g, (run) => ` ${[...run].map((c) => SUPERSCRIPTS.indexOf(c)).join('')} `);
    result = result.replace(/[Ͱ-Ͽµ]/g, (letter) => (GREEK[language][letter] ? ` ${GREEK[language][letter]} ` : letter));

    result = result.replace(UNIT_PATTERN, (match, number, unit) => {
        const [singular, plural, hindi] = UNITS[unit];
        return `${number} ${language === 'hi' ? hindi : (number === '1' ? singular : plural)}`;
    });
    for (const [symbol, word] of Object.entries(DEGREES[language])) {
        result = result.replaceAll(symbol, ` ${word} `);
    }
    for (const [symbol, word] of Object.entries(SYMBOLS[language])) {
        result = result.replaceAll(symbol, ` ${word} `);
    }
    for (const [symbol, word] of Object.entries(SPACED_SYMBOLS[language])) {
        result = result.replace(new RegExp(`(?<=[\\s\\d])${escapeRegExp(symbol)}(?=[\\s\\d])`, 'g'), ` ${word} `);
    }

    const latinLetters = text.match(/[A-Za-z]/g) || [];
    const inHeading = latinLetters.length >= 8 && latinLetters.filter((c) => c <= 'Z').length / latinLetters.length > 0.6;
    result = result.replace(new RegExp(`(?<!${WORD_CHAR})[A-Z0-9]{2,6}(?!${WORD_CHAR})`, 'gu'),
        (token) => (isAcronym(token, inHeading) ? ` ${[...token].join(' ')} ` : token));

    if (language === 'hi') {
        // Thousands separators, including Indian grouping (1,00,000), but not lists like "1,2,3".
        result = result.replace(/(\d),(?=\d{2,3}(?!\d))/g, '$1');
        result = result.replace(/\d+(?:\.\d+)?/g, sayHindiNumber);
    }

    result = result.replace(/(.)/g, (match, code) => ` ${protectedSay[code.charCodeAt(0) - 0xE100]} `);
    return result.replace(/\s+/g, ' ').replace(/ ([.,;:!?।)\]])/g, '$1').trim();
}
