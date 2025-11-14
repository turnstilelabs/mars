// Global variables to hold the data and current state
let allData = [];
let papers = [];
let currentPaperId = null;
let currentArtifactId = null;
let currentQueries = [];

// --- REVISED MATH PROCESSING LOGIC ---

/**
 * A robust, single-pass function to process a raw LaTeX string for safe HTML display with MathJax.
 *
 * This function performs several key operations in a specific order:
 * 1.  **Normalization:** Converts LaTeX environments like `\begin{equation}` into MathJax's preferred `\[...\]` delimiters.
 * 2.  **Cleaning:** Removes cross-reference commands (`\label`, `\ref`, `\cite`) that would render as "[??]".
 *     It also simplifies list environments without being overly aggressive.
 * 3.  **Safe HTML Rendering:** This is the most critical step. The function splits the string into math segments
 *     (e.g., $...$, \[...\]) and text segments. It leaves the math untouched for MathJax but escapes any
 *     HTML-sensitive characters (`<`, `>`, `&`) in the text segments. This prevents formatting issues and
 *     potential XSS vulnerabilities.
 *
 * @param {string | null | undefined} rawStr The raw string from the JSON data.
 * @returns {string} A sanitized and HTML-safe string ready for `innerHTML`.
 */
function processLatexForDisplay(rawStr) {
    if (rawStr == null) return '';
    let processedStr = String(rawStr);

    // 1. Normalize LaTeX environments to MathJax delimiters
    // Handles both equation and align, with or without stars.
    processedStr = processedStr.replace(/\\begin\{(equation|align)\*?\}([\s\S]*?)\\end\{\1\*?\}/g, (match, env, inner) => {
        return `\\[${inner.trim()}\\]`;
    });

    // 2. Clean disruptive LaTeX commands and environments
    processedStr = processedStr
        // Remove labels, refs, and citations to prevent "[??]"
        .replace(/\\(label|ref|eqref|cite)\{[^}]*\}/g, '')
        // Rudimentary list handling: strip environments, convert \item to a line break + bullet.
        .replace(/\\begin\{(enumerate|itemize)\}(\[[^\]]*\])?/g, '')
        .replace(/\\end\{(enumerate|itemize)\}/g, '')
        .replace(/\\item\s*/g, '<br>• ') // Using <br> which we will protect during escaping
        // General cleanup
        .replace(/~/g, ' ') // Non-breaking space to normal space
        .replace(/\s{2,}/g, ' ') // Collapse multiple spaces
        .trim();

    // 3. Safe HTML Rendering (Split-and-Escape)
    const SENTINEL = '__BR_SENTINEL__';
    // Protect our own injected <br> tags before escaping
    processedStr = processedStr.replace(/<br\s*\/?>/g, SENTINEL);

    const escapeHTML = (s) => s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // Regex to find all standard MathJax delimiters
    const re = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$[\s\S]*?\$)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(processedStr))) {
        // Text segment before this math
        const textSeg = processedStr.slice(last, m.index);
        out += escapeHTML(textSeg);
        // Math segment: preserve TeX but protect HTML-sensitive chars and bad \hspace
        const mathSeg = m[0]
            .replace(/\\hspace\s*\{\s*\}/g, '\\,')
            .replace(/\\hspace(?!\s*\{[^}]+\})/g, '\\,')
            .replace(/</g, '<')
            .replace(/>/g, '>');
        out += mathSeg;
        last = re.lastIndex;
    }
    if (last < processedStr.length) {
        out += escapeHTML(processedStr.slice(last));
    }

    // Restore the protected <br> tags and return
    return out.replace(new RegExp(SENTINEL, 'g'), '<br>');
}


// --- Utility Functions (largely unchanged, but essential) ---

// Utility: robustly parse predicted_candidates which may be Python-like strings
function parseCandidates(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw == null) return [];
    let text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];

    try { return JSON.parse(text); } catch (e) {
        try {
            let s = text.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
            s = s.replace(/([\{,]\s*)'([^'\n]*?)'\s*:/g, '$1"$2":');
            s = s.replace(/:\s*'([^'\n]*?)'(\s*[\},])/g, (_, val, tail) => ': ' + JSON.stringify(val) + tail);
            s = s.replace(/(\[|\s,)\s*'([^'\n]*?)'\s*(?=(,|\]))/g, (_, lead, val) => lead + JSON.stringify(val));
            return JSON.parse(s);
        } catch (e) {
            try {
                // Last resort: guarded eval for simple literals
                if (/^[\s\[\]\{\}:,0-9.\-+eEtruaflsn"'\u2010-\u206F\u0009\u000A\u000D\u0020A-Za-z&;()_]*$/.test(text)) {
                    return Function('"use strict";return (' + text + ')')();
                }
            } catch (e) { /* fall through */ }
        }
    }
    return []; // Return empty array on failure
}

// Utility: format confidence and escape HTML for safe rendering
function formatConfidence(c) {
    const num = Number(c);
    if (!isFinite(num)) return String(c);
    return num <= 1 ? Math.round(num * 100) + '%' : String(num);
}
function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[m]));
}

// --- DOM and Application Logic (updated to use the new processor) ---

// DOM Elements
const paperSelect = document.getElementById('paper-select');
const paperTitle = document.getElementById('paper-title');
const paperControls = document.getElementById('paper-controls');
const artifactIdSpan = document.getElementById('artifact-id');
const artifactText = document.getElementById('artifact-text');
const prevBtn = document.getElementById('prev-artifact');
const nextBtn = document.getElementById('next-artifact');
const queriesContainer = document.getElementById('generated-queries');
const referencesContainer = document.getElementById('candidate-references');

// Fetch and initialize the application
fetch('data.json')
    .then(response => response.json())
    .then(data => {
        allData = data;
        papers = (Array.isArray(allData) ? allData : []).map(p => ({
            id: p.id || p.arxiv_id || p.paper_id,
            title: p.title || p.arxiv_title || '',
            artifacts: (p.artifacts || []).map(a => ({
                id: a.id || a.artifact_id,
                text: a.text || a.artifact_text || (a.queries && a.queries[0] ? a.queries[0].artifact_text : ''),
                queries: a.queries || []
            }))
        }));

        if (papers.length === 0) {
            paperTitle.textContent = "No papers found in data.json";
            return;
        }

        if (paperSelect) {
            populatePaperSelect();
        }
        setupEventListeners();

        const h = parseHash();
        const DEFAULT_PAPER_ID = '2310.00736v2';
        const fallbackId = papers.some(p => p.id === DEFAULT_PAPER_ID) ? DEFAULT_PAPER_ID : papers[0].id;
        currentPaperId = (h.paperId && papers.some(p => p.id === h.paperId)) ? h.paperId : fallbackId;
        const initPaper = papers.find(p => p.id === currentPaperId);
        currentArtifactId = (h.artifactId && initPaper && initPaper.artifacts.some(a => a.id === h.artifactId))
            ? h.artifactId
            : (initPaper && initPaper.artifacts[0] ? initPaper.artifacts[0].id : null);

        displayArtifact();

        window.addEventListener('hashchange', () => {
            const hh = parseHash();
            if (!hh.paperId || !papers.some(p => p.id === hh.paperId)) return;
            currentPaperId = hh.paperId;
            const p = papers.find(pp => pp.id === currentPaperId);
            currentArtifactId = (hh.artifactId && p.artifacts.some(a => a.id === hh.artifactId))
                ? hh.artifactId
                : (p.artifacts[0] ? p.artifacts[0].id : null);
            displayArtifact();
        });
    })
    .catch(error => {
        console.error("Error loading the data:", error);
        paperTitle.textContent = "Failed to load data. See console for details.";
    });

function populatePaperSelect() {
    papers.forEach(paper => {
        const option = document.createElement('option');
        option.value = paper.id;
        option.textContent = paper.title || paper.id;
        option.title = paper.id;
        paperSelect.appendChild(option);
    });
}

function handlePaperChange() {
    currentPaperId = paperSelect ? paperSelect.value : papers[0].id;
    const paper = papers.find(p => p.id === currentPaperId);
    if (paper && paper.artifacts.length > 0) {
        currentArtifactId = paper.artifacts[0].id;
        displayArtifact();
    }
}

function parseHash() {
    const out = { paperId: null, artifactId: null };
    const hash = window.location.hash.slice(1);
    if (!hash) return out;
    const params = new URLSearchParams(hash);
    out.paperId = params.get('paper');
    out.artifactId = params.get('artifact');
    return out;
}

function updateHash() {
    const p = encodeURIComponent(currentPaperId || '');
    const a = encodeURIComponent(currentArtifactId || '');
    const newHash = `#paper=${p}&artifact=${a}`;
    if (window.location.hash !== newHash) {
        // Use replaceState to avoid cluttering browser history
        history.replaceState(null, '', newHash);
    }
}

function displayArtifact() {
    if (!currentPaperId || !currentArtifactId) return;

    const paper = papers.find(p => p.id === currentPaperId);
    const artifact = paper.artifacts.find(a => a.id === currentArtifactId);
    updateHash();

    const titleText = paper.title || paper.id;
    const arxivId = String(paper.id || '').trim();
    const href = arxivId ? `https://arxiv.org/abs/${encodeURIComponent(arxivId)}` : '#';
    paperTitle.textContent = titleText;

    if (paperControls) {
        paperControls.innerHTML = `
            <a href="${href}" target="_blank" rel="noopener noreferrer" class="btn">See on arXiv</a>
            <a href="#" id="next-paper-btn" class="btn">Next Paper</a>
        `;
        document.getElementById('next-paper-btn').addEventListener('click', (e) => {
            e.preventDefault();
            const idx = papers.findIndex(p => p.id === currentPaperId);
            const nextIdx = (idx + 1) % papers.length;
            currentPaperId = papers[nextIdx].id;
            const nextPaper = papers[nextIdx];
            currentArtifactId = nextPaper.artifacts?.[0]?.id || null;
            displayArtifact();
        });
    }

    artifactIdSpan.textContent = 'Original Theorem';

    // *** USE THE NEW, UNIFIED FUNCTION ***
    artifactText.innerHTML = processLatexForDisplay(artifact.text);

    // Trigger MathJax to render the newly set content
    if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetPromise([artifactText]).catch(err => console.error("MathJax typesetting failed:", err));
    }

    currentQueries = artifact.queries;
    displayQueries();

    if (currentQueries.length > 0) {
        displayReferences(0);
        const firstQueryBlock = queriesContainer.querySelector('.query-block');
        if (firstQueryBlock) {
            firstQueryBlock.classList.add('selected');
        }
    } else {
        referencesContainer.innerHTML = "<p>No references for this artifact.</p>";
    }

    updateNavButtons();
}

function displayQueries() {
    queriesContainer.innerHTML = '';
    currentQueries.forEach((query, index) => {
        const queryBlock = document.createElement('div');
        queryBlock.className = 'query-block';
        queryBlock.dataset.index = index;

        // *** USE THE NEW, UNIFIED FUNCTION ***
        const preparedQueryHTML = processLatexForDisplay(query.query || '');

        queryBlock.innerHTML = `
            <span class="query-category">${escapeHTML(query.category).replace(/_/g, ' ')}</span>
            <div class="query-text">${preparedQueryHTML}</div>
        `;

        queryBlock.addEventListener('click', () => {
            queriesContainer.querySelectorAll('.query-block.selected').forEach(b => b.classList.remove('selected'));
            queryBlock.classList.add('selected');
            displayReferences(index);
        });
        queriesContainer.appendChild(queryBlock);
    });

    if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetPromise([queriesContainer]).catch(err => console.error("MathJax typesetting failed:", err));
    }
}

function displayReferences(queryIndex) {
    const query = currentQueries[queryIndex];
    referencesContainer.innerHTML = '';
    const candidates = parseCandidates(query.predicted_candidates);

    if (!candidates || candidates.length === 0) {
        referencesContainer.innerHTML = '<p>No candidate references found.</p>';
        return;
    }

    candidates.forEach(candidate => {
        const refCard = document.createElement('div');
        refCard.className = 'reference-card';

        const buildCard = (title, confidence, reasoning) => {
            const titleHTML = `<b>${escapeHTML(title)}</b>`;
            const hasConf = !(confidence === '' || confidence == null || (typeof confidence === 'number' && !isFinite(confidence)));
            const confText = hasConf ? formatConfidence(confidence) : '—';
            const confHTML = `<div class="confidence">LLM Confidence: ${confText}</div>`;
            const reasoningHTML = (reasoning ? `<details class="reasoning"><summary>Reasoning</summary><div>${escapeHTML(reasoning)}</div></details>` : '');
            return `${titleHTML}${confHTML}${reasoningHTML}`;
        };

        if (typeof candidate === 'string') {
            refCard.innerHTML = buildCard(candidate, '', '');
        } else {
            const ref = candidate.reference || {};
            const title = ref.title || candidate.title || 'N/A';
            const confidence = candidate.confidence ?? candidate.score ?? '';
            const reasoning = candidate.reasoning || '';
            refCard.innerHTML = buildCard(title, confidence, reasoning);
        }

        referencesContainer.appendChild(refCard);
    });
}

function updateNavButtons() {
    const paper = papers.find(p => p.id === currentPaperId);
    if (!paper) return;
    const currentIndex = paper.artifacts.findIndex(a => a.id === currentArtifactId);
    prevBtn.classList.toggle('disabled', currentIndex <= 0);
    nextBtn.classList.toggle('disabled', currentIndex >= paper.artifacts.length - 1);
}

function setupEventListeners() {
    if (paperSelect) {
        paperSelect.addEventListener('change', handlePaperChange);
    }
    prevBtn.addEventListener('click', () => {
        const paper = papers.find(p => p.id === currentPaperId);
        const currentIndex = paper.artifacts.findIndex(a => a.id === currentArtifactId);
        if (currentIndex > 0) {
            currentArtifactId = paper.artifacts[currentIndex - 1].id;
            displayArtifact();
        }
    });
    nextBtn.addEventListener('click', () => {
        const paper = papers.find(p => p.id === currentPaperId);
        const currentIndex = paper.artifacts.findIndex(a => a.id === currentArtifactId);
        if (currentIndex < paper.artifacts.length - 1) {
            currentArtifactId = paper.artifacts[currentIndex + 1].id;
            displayArtifact();
        }
    });
}
