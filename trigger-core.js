/**
 * 拾帧触发核心（纯逻辑层）。
 *
 * 只解析完整 image###提示词### 标记；由入口层提供稳定消息/目标标识。
 * 自动触发通过 begin() 幂等去重；用户主动“再画一张”必须走 beginCandidate()，
 * 保留同一触发任务下已经生成的结果，避免把旧图覆盖掉。
 */
export const IMAGE_MARKER = "image###";

export function parseImageMarkers(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  const re = /image###([\s\S]*?)###/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const prompt = match[1].trim();
    if (!prompt) continue;
    found.push({ index: match.index, end: re.lastIndex, prompt, marker: match[0] });
  }
  return found;
}

export function inspectMessage(text, { isFinal = false } = {}) {
  const markers = parseImageMarkers(text);
  return {
    markers,
    ready: isFinal && markers.length > 0,
    visibleText: typeof text === "string"
      ? text.replace(/image###([\s\S]*?)###/g, "").trim()
      : "",
  };
}

export function makeTriggerId({ chatId, messageId, markerIndex }) {
  if (chatId == null || messageId == null || markerIndex == null) {
    throw new TypeError("chatId、messageId 和 markerIndex 都是必需的稳定标识");
  }
  return [chatId, messageId, markerIndex].map(String).join(":");
}

export class TriggerRegistry {
  #tasks = new Map();

  begin(triggerId, payload = {}) {
    const existing = this.#tasks.get(triggerId);
    if (existing && ["pending", "running", "succeeded"].includes(existing.status)) {
      return { accepted: false, task: this.get(triggerId) };
    }
    return this.#start(triggerId, payload, existing);
  }

  /** 用户主动再画一张：成功任务允许重新进入 running，但不清空旧结果。 */
  beginCandidate(triggerId, payload) {
    const existing = this.#tasks.get(triggerId);
    if (!existing || existing.status !== "succeeded") {
      return { accepted: false, task: existing ? this.get(triggerId) : null };
    }
    return this.#start(triggerId, payload ?? existing.payload, existing);
  }

  retry(triggerId, payload) {
    const existing = this.#tasks.get(triggerId);
    if (!existing || existing.status !== "failed") {
      return { accepted: false, task: existing ? this.get(triggerId) : null };
    }
    return this.#start(triggerId, payload ?? existing.payload, existing);
  }

  #start(triggerId, payload, existing) {
    const task = {
      triggerId,
      status: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      resultIds: [...(existing?.resultIds ?? [])],
      payload: { ...(payload ?? {}) },
      error: null,
    };
    this.#tasks.set(triggerId, task);
    return { accepted: true, task: this.get(triggerId) };
  }

  markRunning(triggerId) {
    return this.#update(triggerId, task => {
      if (task.status !== "pending") throw new Error("只有 pending 任务可以启动");
      task.status = "running";
    });
  }

  markSucceeded(triggerId, resultId) {
    return this.#update(triggerId, task => {
      if (task.status !== "running") throw new Error("只有 running 任务可以成功结束");
      task.status = "succeeded";
      if (resultId != null) task.resultIds.push(resultId);
      task.error = null;
    });
  }

  markFailed(triggerId, errorMessage = "生成失败") {
    return this.#update(triggerId, task => {
      if (task.status !== "running" && task.status !== "pending") {
        throw new Error("当前任务状态不允许标记失败");
      }
      task.status = "failed";
      task.error = String(errorMessage);
    });
  }

  get(triggerId) {
    const task = this.#tasks.get(triggerId);
    return task ? {
      ...task,
      resultIds: [...task.resultIds],
      payload: { ...task.payload },
    } : null;
  }

  #update(triggerId, update) {
    const task = this.#tasks.get(triggerId);
    if (!task) throw new Error(`未知触发任务：${triggerId}`);
    update(task);
    task.updatedAt = Date.now();
    return this.get(triggerId);
  }
}
