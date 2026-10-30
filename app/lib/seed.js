'use strict';
// 최초 실행 시 채워 넣는 기본 데이터
const fs = require('fs');
const path = require('path');

exports.prompts = (newId, ts) => [
  {
    id: newId(), title: '이미지 프롬프트 설계', tags: ['이미지'], createdAt: ts, updatedAt: ts,
    description: '아이디어를 Seedream용 영문 이미지 프롬프트로 다듬고 바로 생성까지 합니다.',
    content: '다음 아이디어로 이미지를 만들어줘. 먼저 피사체·구도·조명·스타일을 정리한 영문 프롬프트를 보여주고, 그 프롬프트로 generate_image 도구를 호출해.\n\n아이디어: {{아이디어}}\n비율/크기: {{크기:2K}}'
  },
  {
    id: newId(), title: '코드 리뷰', tags: ['개발'], createdAt: ts, updatedAt: ts,
    description: '버그 위험이 큰 순서로 짚어 줍니다.',
    content: '아래 코드를 리뷰해줘. 실제로 문제를 일으킬 수 있는 버그부터 순서대로, 줄 번호와 고치는 방법까지 알려줘. 스타일 지적은 마지막에 짧게.\n\n```{{언어:}}\n{{코드}}\n```'
  },
  {
    id: newId(), title: '요약', tags: ['글쓰기'], createdAt: ts, updatedAt: ts,
    description: '긴 글을 핵심만 남겨 정리합니다.',
    content: '다음 내용을 {{분량:5줄}} 안으로 요약해줘. 숫자와 고유명사는 그대로 살려줘.\n\n{{본문}}'
  }
];

exports.mcp = (root) => ({
  mcpServers: {
    'echo-test': {
      command: process.execPath,
      args: [path.join(root, 'app', 'examples', 'echo-mcp-server.js')],
      disabled: false,
      autoApprove: true
    },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', path.join(root, 'data', 'workspace')],
      disabled: true
    }
  }
});

const SAMPLE_SKILLS = {
  'image-prompt-director': `---
name: image-prompt-director
description: 이미지 생성 요청을 받으면 Seedream에 맞는 영문 프롬프트로 설계하고 generate_image 도구로 바로 생성한다. "이미지 만들어줘", "그려줘", "포스터", "썸네일", "컨셉 아트" 같은 요청에 사용.
---

# 이미지 프롬프트 디렉터

## 작업 순서
1. 사용자의 요청에서 피사체, 행동, 배경, 분위기, 스타일, 용도(썸네일·포스터 등)를 뽑는다.
2. 빠진 정보가 결과를 크게 바꾸는 경우에만 한 번 묻는다. 나머지는 합리적으로 정한다.
3. 영문 프롬프트를 다음 순서로 쓴다: 피사체 → 행동/포즈 → 배경 → 구도/카메라 → 조명 → 스타일/질감 → 품질 키워드.
4. 사용자가 첨부한 이미지가 있으면 \`use_attached_images: true\` 로 참조 이미지를 넘긴다.
5. generate_image 를 호출하고, 결과 아래에 한국어로 한두 줄 설명을 붙인다.

## 크기 가이드
- 기본 2K. 세로 포스터는 "1728x2304", 가로 썸네일은 "2560x1440" 처럼 픽셀로 지정할 수 있다.

## 금지
- 실존 인물의 얼굴을 사실적으로 합성하는 요청은 정중히 거절한다.
- 프롬프트에 텍스트 렌더링이 필요하면 따옴표로 정확한 문구를 넣는다.
`,
  'korean-writing': `---
name: korean-writing
description: 사람이 읽을 한국어 글(블로그, 공지, 소개글, 카피)을 쓸 때 번역투와 AI 말투를 피해 자연스럽게 쓰는 규칙.
---

# 자연스러운 한국어 작문

- "~에 대해", "~를 통해", "~하는 것이 가능하다" 같은 번역투를 줄이고 동사로 바로 쓴다.
- 문장 길이를 일부러 섞는다. 짧은 문장 다음에 긴 문장이 와도 좋다.
- "또한", "뿐만 아니라", "결론적으로" 같은 접속사를 문단마다 붙이지 않는다.
- 불릿과 이모지는 꼭 필요한 곳에만 쓴다. 설명은 문단으로 푼다.
- 피동("~되어진다") 대신 능동으로 쓴다.
- 사실, 숫자, 고유명사는 절대 바꾸지 않는다.
`
};

exports.skills = (dir) => {
  // app/examples/skills 의 기본 스킬은 없을 때마다 채워 넣는다
  const examples = path.join(__dirname, '..', 'examples', 'skills');
  if (fs.existsSync(examples)) {
    for (const name of fs.readdirSync(examples)) {
      const src = path.join(examples, name, 'SKILL.md');
      const dst = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(src) && !fs.existsSync(path.join(dir, name))) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }
  const marker = path.join(dir, '.seeded');
  if (fs.existsSync(marker)) return;
  for (const [name, body] of Object.entries(SAMPLE_SKILLS)) {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'SKILL.md');
    if (!fs.existsSync(f)) fs.writeFileSync(f, body, 'utf8');
  }
  fs.writeFileSync(marker, new Date().toISOString());
};
