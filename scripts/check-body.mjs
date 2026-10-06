#!/usr/bin/env node
// 体态检查：扫描 Dflow 库里所有带身体特征 tag 的卡，检查提示词的体态描述是否合格。
// 用法：node scripts/check-body.mjs
// 反推完成后跑一遍，任何 [!] 都要回读重写。

const BASE = process.env.DFLOW_BASE || 'http://127.0.0.1:4173';

// tag → 提示词里必须出现的部位词；physical=true 表示该部位还必须有"物理后果"
const TAG_RULES = [
  { tags: /爆乳|巨乳|美乳|極上の乳|乳神様/, need: /\b(breasts?|bust|chest)\b/i, label: '胸部体积', physical: true },
  { tags: /ふともも|美脚/, need: /\b(thighs?|legs?)\b/i, label: '大腿', physical: true },
  { tags: /足裏|足指|裸足/, need: /\b(soles?|toes?|feet|foot)\b/i, label: '足部', physical: false },
  { tags: /お尻|\bass\b/, need: /\b(hips?|buttocks?|rear|behind)\b/i, label: '臀部', physical: true },
  { tags: /ボディストッキング|白丝|黑丝|thighhighs|tights/, need: /\b(stockings?|tights|bodystocking)\b/i, label: '袜类材质', physical: true },
];

// 体型相关的瘦信号短语：与丰满描述直接冲突，必须删
const SLIM_PHRASES =
  /\bnarrow waist\b|\bslim (waist|figure|body|build)\b|\bslender (figure|body|build)\b|\bwillowy\b|\bdelicate (figure|frame|build|body)\b/i;

// 物理后果：体积对周边物体的作用（光有形容词不算，要写出后果）
const PHYSICAL =
  /press(es|ed|ing)? (in|into)|sink(s|ing)? into|bit(e|es|ing) (deep )?into|bulg(e|es|ing)|spill(s|ing)|spreading|stretch(es|ed|ing)? (taut|tight)|strain(s|ing)?|grip(s|ping|ped)?|under its own weight|flesh/i;

const state = await (await fetch(BASE + '/api/state')).json();

let problems = 0;
let checked = 0;
for (const f of state.favorites) {
  if (!f.prompt) continue;
  const tags = f.tag_string_general || '';
  const bodyTags = TAG_RULES.filter((r) => r.tags.test(tags));
  if (bodyTags.length === 0) continue;
  checked++;

  const issues = [];
  for (const r of bodyTags) {
    if (!r.need.test(f.prompt)) issues.push(`缺少${r.label}描述`);
  }
  if (SLIM_PHRASES.test(f.prompt)) issues.push('含瘦信号短语，与丰满描述冲突');
  if (bodyTags.some((r) => r.physical) && !PHYSICAL.test(f.prompt)) {
    issues.push('缺少物理后果（肉被挤压／衣物陷进／高光撑开）');
  }

  if (issues.length) {
    problems++;
    console.log(`[!] ${f.id}`);
    console.log(`    tags: ${tags}`);
    for (const i of issues) console.log(`    - ${i}`);
  }
}

console.log(
  problems === 0
    ? `\n检查 ${checked} 张，全部通过。`
    : `\n检查 ${checked} 张，${problems} 张需复核。`,
);
