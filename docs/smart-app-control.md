# 智能应用控制拒绝 Python 编译模块：诊断与放行

插件 ZipVoice 引擎自带一套 Python 运行时（约 7.7 GB，257 个 `.pyd`）。开着「智能应用控制」
（Smart App Control，SAC）的 Windows 11 上，这些未签名编译模块被代码完整性策略拒绝，引擎起不来，
表现就是不朗读。

**重要的是**：这个问题装包修不了。安装或升级本插件不会动系统策略，必须由你在这台机器上手动做一次
（管理员权限 + 重启一次），也就是第 3 节那段脚本。

**怎么用这篇文档**：只想修好，直接跳第 3 节，改两个变量、整段粘进管理员 PowerShell、重启一次；
想知道为什么，从第 1 节看。

## 1. 先确认是不是这个原因

事件日志 `Microsoft-Windows-CodeIntegrity/Operational` 找 ID `3077`：

```
Code Integrity determined that a process (...python.exe) attempted to load
...\cytoolz\utils.cp310-win_amd64.pyd that did not meet the Enterprise signing level
requirements or violated code integrity policy (Policy ID:{0283ac0f-fff1-49ae-ada1-8a933130cad6}).
```

或直接复现（报 `DLL load failed ... 应用程序控制策略已阻止此文件` 即命中）：

```
%LOCALAPPDATA%\dsh-voice-mode\runtimes\<runtime>\Scripts\python.exe -c "from cytoolz import utils; print(utils.__file__)"
```

## 2. 为什么会被拒

SAC 开着（`VerifiedAndReputablePolicyState=1`，`CodeIntegrityPolicyEnforcementStatus=2`），
生效的是微软内置平台策略 `VerifiedAndReputableDesktop`（`{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`，
平台 ID `{2E07F7E4-194C-4D20-B7C9-6F44A6C5A234}`），按「签名 + 信誉」放行；未签名的 `.pyd`
过不去（实测这套环境 257 个里只有 1 个带有效签名）。

平台策略改不了，但它的选项里有 `Enabled:Allow Supplemental Policies`，系统里也已挂着微软自己的
补充策略。做法是**再加一层补充策略，按路径放行运行时目录**，不用关 SAC（关掉要重装系统才能再开）。

## 3. 做法

以管理员打开 PowerShell，改下面两个变量，然后把整段粘贴执行，最后重启一次。

```powershell
$RuntimePath = "$env:LOCALAPPDATA\dsh-voice-mode\runtimes"      # 要放行的运行时代码目录
$PolicyDir   = "C:\ProgramData\DshVoicePolicy"                   # 策略文件放这里

New-Item -ItemType Directory -Force -Path $PolicyDir | Out-Null
$PolicyId = "{" + [guid]::NewGuid().ToString().ToUpper() + "}"

# 1) 自签一张策略签名证书，并装进受信任根
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=DshVoicePolicySigner" `
  -CertStoreLocation "Cert:\LocalMachine\My" -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
Export-Certificate -Cert $cert -FilePath "$PolicyDir\signer.cer" -Force | Out-Null
Import-Certificate -FilePath "$PolicyDir\signer.cer" -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null

# 2) 写补充策略：基础策略是那个平台策略，规则按路径放行
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<SiPolicy xmlns="urn:schemas-microsoft-com:sipolicy" PolicyType="Supplemental Policy">
  <VersionEx>10.0.0.0</VersionEx>
  <PlatformID>{2E07F7E4-194C-4D20-B7C9-6F44A6C5A234}</PlatformID>
  <BasePolicyID>{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}</BasePolicyID>
  <PolicyID>$PolicyId</PolicyID>
  <Rules />
  <FileRules>
    <Allow ID="ID_ALLOW_VOICE_RUNTIME" FriendlyName="allow dsh voice runtime" FilePath="$RuntimePath\*" />
  </FileRules>
  <Signers />
  <SigningScenarios>
    <SigningScenario ID="ID_SIGNINGSCENARIO_UMCI" FriendlyName="User mode" Value="12">
      <ProductSigners>
        <FileRulesRef><FileRuleRef RuleID="ID_ALLOW_VOICE_RUNTIME" /></FileRulesRef>
      </ProductSigners>
    </SigningScenario>
  </SigningScenarios>
</SiPolicy>
"@
[IO.File]::WriteAllText("$PolicyDir\supplemental.xml", $xml, (New-Object Text.UTF8Encoding($false)))

# 3) 补更新签名规则（不带 -Update 会报「需要已签名的策略，但未指定 UpdatePolicySigner」）
Add-SignerRule -FilePath "$PolicyDir\supplemental.xml" -CertificatePath "$PolicyDir\signer.cer" -Update

# 4) 转二进制、签名、部署
ConvertFrom-CIPolicy -XmlFilePath "$PolicyDir\supplemental.xml" -BinaryFilePath "$PolicyDir\supplemental.cip"
Set-AuthenticodeSignature -FilePath "$PolicyDir\supplemental.cip" -Certificate $cert -HashAlgorithm SHA256
CiTool.exe --update-policy "$PolicyDir\supplemental.cip"

"已部署补充策略 $PolicyId，重启后生效"
```

三个必踩点：XML 里 `<Rules />` 必须有，节点顺序是 Rules、FileRules、Signers、SigningScenarios；
`FilePath` 必须写绝对路径（不展开 `%LOCALAPPDATA%`），`*` 只能放末尾；
`Add-SignerRule` 只能加 `-Update`（`-Supplemental` 给基础策略用，加了会报错）。

重启是必须的：`CiTool.exe --refresh` 热加载不了（实测重启前策略已列出、规则不生效）。

## 4. 验证

1. 不再出现新的 `3077`（拿系统启动时间对比最后一条拦截时间）。
2. 被拒文件能直接导入：`python.exe -c "from cytoolz import utils; print(utils.__file__)"`
   返回真实的 `site-packages\cytoolz\utils.cp310-win_amd64.pyd`，加载器是 `ExtensionFileLoader`。
3. 端到端：拉起 TTS worker 能就绪并合成出音频。

实测对照（Windows 11 专业版 build 26200，SAC 开启）：

| 观测点 | 放行前 | 重启后 |
|---|---|---|
| 事件 `3077` | 14 条，3 类文件（cytoolz `utils...pyd` ×9、`__triton_launcher.pyd` ×4、scipy `_sparsetools...pyd` ×1） | 0 条新事件 |
| `from cytoolz import utils` | `DLL load failed` | 正常，`ExtensionFileLoader` |
| `import triton` / `import scipy.sparse` | 被拒 | `triton 3.8.0` / 正常 |
| 合成 | 引擎初始化失败 | 清掉任何替身后仍就绪并合成 |

注意：`CiTool` 里这条补充策略可能仍显示「策略已签名 false、当前强制执行 false」，
以事件 `3077` 是否再出现、被拒模块能否加载为准。

## 5. 撤销

```powershell
CiTool.exe --remove-policy {<第 3 节输出的 PolicyId>}
```

删除后重启回到拦截状态。补充策略只有「允许」规则、没有拒绝规则，写错的最坏结果是「不生效」，
不会挡住别的程序。证书可用 `Remove-Item Cert:\LocalMachine\My\<指纹>` 与 `Root\<指纹>` 清理。

## 6. 边界

- 只覆盖用户态（`Value="12"`）；内核态模块若被拦需另加场景。
- 按路径放行 = 该目录下任何文件都放行，目录必须是本插件自己的运行时，不能指向用户可写的大目录。
- 撤销命令没真删过（为少重启一次），「删完恢复拦截」是机制推断，不是观测。
- 只在一个 Windows 版本/补丁级别上跑过；换版本、与其它策略共存、后续更新重新评估均未验证。
- 不要用关 SAC 换清静：关掉之后要重装系统才能再打开。
