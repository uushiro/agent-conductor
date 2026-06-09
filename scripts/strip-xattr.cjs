// afterPack hook: codesign が "resource fork, Finder information, or similar
// detritus not allowed" で失敗するのを防ぐ。Electron zip 展開時に .app/.framework
// ディレクトリへ com.apple.FinderInfo が付与されるため、署名前に除去する。
// （com.apple.provenance は xattr -c では消えないが codesign は許容する）
const { execSync } = require('child_process');

exports.default = async function stripXattr(context) {
  execSync(`xattr -cr "${context.appOutDir}"`, { stdio: 'inherit' });
  console.log(`  • stripped xattrs  dir=${context.appOutDir}`);
};
