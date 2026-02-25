# Agent Conductor

Claude Code / Gemini CLI のマルチセッション管理デスクトップアプリ。

複数の AI エージェントセッションをタブで並列管理し、セッションの自動保存・復元、タスク管理、ファイルツリーを統合した Electron アプリケーションです。

## 機能一覧

### タブ管理
- **マルチタブ**: Claude / Gemini / 素のターミナルをタブで並列起動
- **タブ追加**: 右上の `+` ボタンから Claude / Gemini / Terminal を選択
- **タブ名編集**: タブをダブルクリックで名前を変更
- **タブ並べ替え**: タブをドラッグで順序変更
- **タブ閉じる**: Claude/Gemini セッションがある場合は確認ダイアログ表示
- **閉じたタブの復元**: `↺` ボタンから最近閉じたタブを復元

### セッション管理
- **自動保存**: アプリ終了時にタブの状態（セッションID、作業ディレクトリ、タブ名等）を自動保存
- **自動復元**: アプリ起動時に前回のセッションを自動で `--resume` して復元
- **復元中表示**: 復元待ちのタブにはタブバー・サイドバーに "Resuming..." と表示
- **復元失敗時の自動フォールバック**: `--resume` が "No conversation found" で失敗した場合、自動的に新しいセッションを開始

### サイドバー
- **セッション一覧**: 全タブのステータスをリアルタイム表示
  - 緑パルスドット: エージェント実行中
  - グレードット: アイドル状態
  - "Thinking..." / ツール名: Claude/Gemini が実行中のアクションを表示
- **タスク管理**: サイドバー下部にタスクリスト
  - テキスト入力で追加
  - チェックで完了
  - ダブルクリックで編集
  - Claude の出力に `[[TASK: タスク名]]` があると自動追加
  - `[[TASK-SETALL: JSON]]` でタスクリスト一括更新
- **タスク送信**: タスク横の ▶ ボタンで新しいエージェントタブにタスクを送信

### ファイルツリー
- サイドバー右上の `▤` ボタンで表示/非表示を切り替え
- アクティブタブの作業ディレクトリに自動追従
- パス表示をクリックして手動でディレクトリを指定（固定モード）
- ファイル右クリック: エディタで開く / パスをコピー
- 隠しファイルの表示切替（`node_modules`, `.git` 等は常に非表示）

### ターミナル
- xterm.js ベースのフルターミナルエミュレータ
- テキストを選択して Backspace/Delete で一括削除
- フォントサイズは設定から変更可能

### 設定（ステータスバーの ⚙ から）
- **テーマ**: Dark / Light
- **フォントサイズ**: 11〜20px（スライダー）
- **言語**: EN / JA
- **アクセントカラー**: 7色プリセット + カスタム Hex コード入力
  - フッターバー、UI のアクセント要素に即時反映
- **エディタ**: ファイルツリーからファイルを開く際のエディタコマンド
  - プリセット: macOS Default / code / cursor / vim / nvim / subl
  - `+` ボタンでカスタムコマンド追加

### カラム幅調整
- サイドバー / ファイルツリー / ターミナルのカラム幅をドラッグで調整
- 幅は再起動後も保持

## キーボードショートカット

| 操作 | キー |
|------|------|
| アプリ終了 | Cmd+Q（確認ダイアログ付き） |

## インストール

### DMG から
1. `dist/Agent Conductor-x.x.x-arm64.dmg` を開く
2. Applications フォルダにドラッグ
3. 初回起動時: 右クリック → 開く（Gatekeeper 対応）

### 開発環境
```bash
cd agent-conductor
npm install
npm run dev
```

### ビルド
```bash
npm run dist
# → dist/Agent Conductor-x.x.x-arm64.dmg
```

## 技術スタック

- **Electron** + **Vite** + **React** + **TypeScript**
- **node-pty**: ターミナルエミュレーション
- **xterm.js**: ターミナルレンダリング
- **electron-builder**: macOS DMG パッケージング

## アーキテクチャ

```
electron/
  main.ts       — メインプロセス（PTY管理、セッション永続化、IPC）
  preload.ts    — contextBridge で安全にAPI公開
src/
  App.tsx        — ルートレイアウト（3カラム + リサイズハンドル）
  components/
    TerminalTabs.tsx  — タブバー + セッション復元
    Terminal.tsx       — xterm.js ラッパー
    Sidebar.tsx        — セッション一覧 + タスクリスト
    FileTreeSidebar.tsx — ファイルツリー
    StatusBar.tsx      — フッター（設定、git branch、バージョン）
    SettingsModal.tsx  — 設定パネル
  contexts/
    SettingsContext.tsx — テーマ/フォント/カラー/エディタ設定
    LangContext.tsx     — 言語切替
```
