#!/usr/bin/env node
/**
 * skill-suggest.js - UserPromptSubmit hook
 * 사용자 프롬프트를 분석하여 최적 스킬을 additionalContext로 추천
 *
 * stdin: { session_id, transcript_path, cwd, ... }
 * stdout: { systemMessage: string } | {}
 */

const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, 'skill-rules.json');

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function normalize(text) {
  return text.toLowerCase().replace(/[^\w가-힣\s]/g, ' ');
}

function scoreSkill(skill, prompt, categories) {
  const text = normalize(prompt);
  let score = 0;

  // 키워드 매칭 (각 키워드당 +15)
  for (const kw of skill.keywords) {
    if (text.includes(normalize(kw))) {
      score += 15;
    }
  }

  // 패턴 매칭 (각 패턴당 +25)
  for (const pat of skill.patterns) {
    try {
      if (new RegExp(pat, 'i').test(prompt)) {
        score += 25;
      }
    } catch {
      // 잘못된 정규식 무시
    }
  }

  // 기본 우선순위 반영
  score += skill.priority * 0.1;

  // 카테고리 부스트
  const cat = categories[skill.category];
  if (cat) {
    score += cat.priority_boost;
  }

  return score;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const prompt = data.user_prompt || data.userPrompt || '';
  if (!prompt || prompt.startsWith('/')) {
    // 슬래시 커맨드는 이미 직접 호출이므로 스킵
    process.stdout.write('{}');
    return;
  }

  const rules = loadRules();
  if (!rules) {
    process.stdout.write('{}');
    return;
  }

  // 모든 스킬에 대해 점수 계산
  const scored = rules.skills
    .map(skill => ({ name: skill.name, score: scoreSkill(skill, prompt, rules.categories) }))
    .filter(s => s.score > 20)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    process.stdout.write('{}');
    return;
  }

  const top = scored.slice(0, 3);
  const primary = top[0];

  let context = `[스킬 추천] 이 요청에 가장 적합한 스킬: /${primary.name}`;
  if (top.length > 1) {
    const alts = top.slice(1).map(s => `/${s.name}`).join(', ');
    context += ` (대안: ${alts})`;
  }
  context += `\n필요시 해당 스킬을 Skill 도구로 호출하세요. 단순 작업이면 직접 처리해도 됩니다.`;

  process.stdout.write(JSON.stringify({ systemMessage: context }));
}

main().catch(() => process.stdout.write('{}'));
