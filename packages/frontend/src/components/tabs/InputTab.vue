<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { Store } from '../../store/createStore.js';
import type { RouteState } from '../../store/routeEventReducer.js';

const props = defineProps<{
  store: Store<RouteState, any>;
}>();

/** 提交载荷：候选池约束已移至「智能路由」页签，此处只提交文本。 */
interface SubmitPayload {
  text: string;
}

const emit = defineEmits<{
  submit: [payload: SubmitPayload];
}>();

const editorText = ref('');
const charCount = computed(() => editorText.value.length);
const overLimit = computed(() => charCount.value > 5000);
const presets = [
  { id: 'code', label: '代码审查', text: '帮我审查这段 Python 代码的性能瓶颈，并给出重构方案' },
  { id: 'write', label: '文案撰写', text: '为一款新上市的智能手表撰写产品介绍文案' },
  { id: 'analyze', label: '数据分析', text: '分析这份销售数据，找出增长趋势和异常点' },
  { id: 'translate', label: '翻译润色', text: '将这段中文技术文档翻译为英文，保持专业术语准确' },
];

function onEditorInput(e: Event) {
  const el = e.target as HTMLElement;
  editorText.value = el.innerText;
}

function exec(cmd: string) {
  if (cmd === 'clear') {
    const editor = document.getElementById('editor');
    if (editor) editor.innerText = '';
    editorText.value = '';
    return;
  }
  document.execCommand(cmd, false);
  const editor = document.getElementById('editor');
  if (editor) editorText.value = editor.innerText;
}

function submit() {
  const text = editorText.value.trim();
  if (!text) return;
  // 候选池约束已移至「智能路由」页签，此处只提交文本
  emit('submit', { text });
}

function usePreset(p: { text: string }) {
  const editor = document.getElementById('editor');
  if (editor) {
    editor.innerText = p.text;
    editorText.value = p.text;
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    submit();
  }
}

// ── 执行结果（紧贴提交按钮下方）────────────────────────────────────────
// 提交后立刻出现，边流边填；空态不占位。

/** 本轮是否已开始（提交后或已有输出）。 */
const showResult = computed(
  () => props.store.state.stage !== 'idle' || props.store.state.resultText.length > 0,
);
const isStreaming = computed(() => props.store.state.streaming);
const showResultDetail = ref(true);
const cursorVisible = ref(false);
let cursorTimer: ReturnType<typeof setInterval> | null = null;

watch(isStreaming, (streaming) => {
  if (streaming) {
    cursorVisible.value = true;
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = setInterval(() => { cursorVisible.value = !cursorVisible.value; }, 530);
  } else {
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
    cursorVisible.value = false;
  }
});

onUnmounted(() => {
  if (cursorTimer) clearInterval(cursorTimer);
});
</script>

<template>
  <div class="sec sec-prompt">
    <div class="sec-t">Prompt 输入<span class="tag">富文本 · ≤5000 字</span></div>
    <div class="rt-toolbar">
      <button data-cmd="bold" title="加粗 (Ctrl+B)" @click="exec('bold')"><b>B</b></button>
      <button data-cmd="italic" title="斜体 (Ctrl+I)" @click="exec('italic')"><i>I</i></button>
      <button data-cmd="insertUnorderedList" title="无序列表" @click="exec('insertUnorderedList')">≡</button>
      <button class="wide" data-cmd="code" title="行内代码" @click="exec('code')">code</button>
      <span class="sp"></span>
      <button class="wide" data-cmd="clear" title="清空内容" @click="exec('clear')">清空</button>
    </div>
    <div
      id="editor"
      class="editor"
      contenteditable="true"
      spellcheck="false"
      role="textbox"
      aria-multiline="true"
      aria-label="Prompt 输入"
      data-ph="在此输入你的 prompt…&#10;例如：帮我审查这段 Python 代码的性能瓶颈，并给出重构方案"
      @input="onEditorInput"
      @keydown="onKeydown"
    ></div>
    <div class="row-count" :class="{ over: overLimit }" :aria-live="overLimit ? 'polite' : undefined">
      <span>{{ charCount }}</span> / 5000
      <span class="dim">≈ {{ Math.ceil(charCount / 4) }} tokens</span>
    </div>
  </div>

  <div class="sec">
    <div class="sec-t">快速示例</div>
    <div class="chip-row">
      <button
        v-for="p in presets"
        :key="p.id"
        class="chip"
        :aria-label="`使用预设：${p.label}`"
        @click="usePreset(p)"
      >{{ p.label }}</button>
    </div>
  </div>

  <button class="primary" :disabled="!editorText.trim()" aria-label="提交路由请求" @click="submit">
    开始 Jev 智能路由 <kbd>⌘⏎</kbd>
  </button>

  <div v-if="showResult" class="sec" style="margin-top:11px">
    <div class="sec-t">
      执行结果
      <span class="tag">流式输出</span>
      <button class="linkbtn" style="margin-left:auto" :aria-expanded="showResultDetail" @click="showResultDetail = !showResultDetail">
        {{ showResultDetail ? '收起' : '展开' }}
      </button>
    </div>
    <div v-if="showResultDetail" class="resultbox" aria-live="polite">
      {{ props.store.state.resultText }}
      <span v-if="isStreaming" class="cur" :style="{ opacity: cursorVisible ? 1 : 0 }"></span>
    </div>
    <div v-if="props.store.state.errorMessage" class="warnbox" style="margin-top:8px" role="alert">
      ⚠ {{ props.store.state.errorMessage }}
    </div>
  </div>
</template>
