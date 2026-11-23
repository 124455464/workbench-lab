/**
 * 模块 0：HJF 物资出库 14 列核算（v3.2 多表连算版 - 独立 iframe 沙箱隔离）
 * 独立隔离：即使外部其他 5 个模块任意修改，本模块代码与 DOM 100% 物理隔离互不干扰。
 */
(function () {
  'use strict';

  WB.register({
    id: 'mod_hjf_embed',
    icon: '🏭',
    title: 'HJF 出库核算',
    mount(container) {
      container.innerHTML = `
        <div class="panel" style="padding:8px 12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <b>🏭 HJF 物资出库 14 列核算（实验隔离副本 · v3.2 多表连算版）</b>
            <span class="pill pill-green">iframe 物理沙箱隔离</span>
          </div>
          <div style="display:flex;gap:8px;">
            <a href="./hjf_lab_embed.html" target="_blank" class="btn-sm" style="text-decoration:none;">↗ 单独新标签全屏打开</a>
          </div>
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;height:calc(100vh - 185px);min-height:680px;">
          <iframe src="./hjf_lab_embed.html" style="width:100%;height:100%;border:none;display:block;" title="HJF出库核算实验副本"></iframe>
        </div>
      `;
    }
  });
})();
