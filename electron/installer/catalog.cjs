const catalog = [
  { id: 'python', name: 'Python', category: '语言', description: 'CPython 解释器与 pip', installMethod: 'winget', packageId: 'Python.Python.3.13', command: 'python.exe', mirrorAvailable: false },
  { id: 'node', name: 'Node.js', category: '运行时', description: 'Node.js、npm，可选 TypeScript', installMethod: 'archive', command: 'node.exe', mirrorAvailable: true },
  { id: 'jdk', name: 'JDK', category: '运行时', description: 'Eclipse Temurin OpenJDK', installMethod: 'archive', command: 'bin/java.exe', mirrorAvailable: false },
  { id: 'go', name: 'Go', category: '语言', description: 'Go 工具链', installMethod: 'archive', command: 'bin/go.exe', mirrorAvailable: true },
  { id: 'rust', name: 'Rust', category: '语言', description: 'rustup、rustc 与 Cargo', installMethod: 'winget', packageId: 'Rustlang.Rustup', command: '.cargo/bin/rustc.exe', mirrorAvailable: false },
  { id: 'dotnet', name: '.NET SDK', category: '运行时', description: '.NET SDK 与 CLI', installMethod: 'archive', command: 'dotnet.exe', mirrorAvailable: false },
  { id: 'cpp', name: 'C/C++', category: '工具链', description: 'MSYS2 MinGW-w64 GCC', installMethod: 'msys2', packageId: 'MSYS2.MSYS2', command: 'mingw64/bin/g++.exe', mirrorAvailable: false },
  { id: 'php', name: 'PHP', category: '语言', description: 'PHP 命令行运行时', installMethod: 'winget', packageId: 'PHP.PHP', command: 'php.exe', mirrorAvailable: false },
  { id: 'ruby', name: 'Ruby', category: '语言', description: 'RubyInstaller 与 RubyGems', installMethod: 'winget', packageId: 'RubyInstallerTeam.RubyWithDevKit.3.4', command: 'ruby.exe', mirrorAvailable: false },
  { id: 'dart', name: 'Dart', category: '语言', description: 'Dart SDK', installMethod: 'archive', command: 'bin/dart.exe', mirrorAvailable: false },
  { id: 'r', name: 'R', category: '语言', description: 'R 语言运行时', installMethod: 'winget', packageId: 'RProject.R', command: 'R.exe', mirrorAvailable: false },
  { id: 'julia', name: 'Julia', category: '语言', description: 'Julia 语言运行时', installMethod: 'winget', packageId: 'Julialang.Julia', command: 'julia.exe', mirrorAvailable: false },
  { id: 'perl', name: 'Perl', category: '语言', description: 'Strawberry Perl', installMethod: 'winget', packageId: 'StrawberryPerl.StrawberryPerl', command: 'perl.exe', mirrorAvailable: false },
  { id: 'lua', name: 'Lua', category: '语言', description: 'MSYS2 Lua', installMethod: 'msys2', packageId: 'MSYS2.MSYS2', command: 'usr/bin/lua.exe', mirrorAvailable: false },
  { id: 'kotlin', name: 'Kotlin', category: '语言', description: 'Kotlin 命令行编译器（需要 JDK）', installMethod: 'archive', command: 'bin/kotlinc.bat', mirrorAvailable: false, dependency: 'jdk' },
  { id: 'scala', name: 'Scala', category: '语言', description: 'Scala 3 编译器（需要 JDK）', installMethod: 'archive', command: 'bin/scala.bat', mirrorAvailable: false, dependency: 'jdk' },
];

const publicCatalog = catalog.map(({ packageId, command, dependency, ...item }) => ({
  ...item,
  supportsCustomPath: item.installMethod === 'archive' || item.installMethod === 'rustup' || item.installMethod === 'msys2',
  supportsSystemScope: item.id !== 'rust' && item.installMethod !== 'msys2',
  supportsPath: item.installMethod === 'archive' || item.installMethod === 'rustup' || item.installMethod === 'msys2',
  ...(dependency ? { dependency } : {}),
}));

module.exports = { catalog, publicCatalog };
