// 自定义源的对外类型：契约层与渲染层都用这几个形状，避免各处各写一份。
export interface CustomSourceView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/** 表单提交的形状：新增时没有 id。 */
export interface CustomSourceDraft {
  id?: string;
  name: string;
  url: string;
  enabled?: boolean;
}

export interface CustomSourceSaveRequest {
  source: CustomSourceDraft;
  /** true = 删除这个来源（按 id） */
  remove?: boolean;
  /** true = 保存前先真连一次接口 */
  test?: boolean;
}

export interface CustomSourceSaveResult {
  success: boolean;
  error?: string;
  /** 保存后的完整清单（失败时是原样清单，界面据此回滚显示） */
  sources: CustomSourceView[];
}
