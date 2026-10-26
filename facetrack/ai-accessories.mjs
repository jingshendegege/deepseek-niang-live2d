export const AI_ACCESSORIES = Object.freeze({
  claude:'ParamAccClaude', gpt:'ParamAccGPT', gemini:'ParamAccGemini', grok:'ParamAccGrok',
  qwen:'ParamAccQwen', glm:'ParamAccGLM', kimi:'ParamAccKimi', minimax:'ParamAccMiniMax', bing:'ParamAccBing',
});
export const AI_LABELS = Object.freeze({claude:'Claude 菊花',gpt:'GPT 盘长结',gemini:'Gemini 星星',grok:'Grok X 徽记',qwen:'千问徽章',glm:'GLM Z 徽章',kimi:'Kimi 月牙',minimax:'MiniMax 声波',bing:'New Bing b 标志'});
export const expressionKey = ref => ref.File.split('/').pop().replace(/\.exp3\.json$/,'');

// Availability is evaluated at the expression boundary. No missing-expression
// calls, synthetic expressions or parameter writes for older exported models.
export function createAccessoryFollow({has, apply, storageKey = 'deepseek-follow-hair'}) {
  let enabled = true, palette = 'deepseek';
  try {enabled = localStorage.getItem(storageKey) !== 'false';} catch {}
  const select = name => {
    for (const key of Object.keys(AI_ACCESSORIES)) {
      const tag = 'acc_ai_' + key;
      if (has(tag)) apply(tag, key === name);
    }
  };
  return {
    get enabled() {return enabled;},
    setEnabled(value) {enabled=!!value;try {localStorage.setItem(storageKey,String(enabled));} catch {} if(enabled)select(palette);},
    hair(name) {palette=name;if(enabled)select(name);},
    manual(tag, on) {if(!has(tag))return;if(on)select(tag.replace(/^acc_ai_/,''));else apply(tag,false);},
  };
}

export function mountAccessoryFollow(host, follow) {
  const label=document.createElement('label'), check=document.createElement('input');
  check.type='checkbox';check.checked=follow.enabled;check.onchange=()=>follow.setEnabled(check.checked);
  label.append(check,document.createTextNode('发饰跟随发色'));host.append(label);
}
