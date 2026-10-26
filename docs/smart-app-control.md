# 智能应用控制拦截 Python 编译模块：诊断与放行

适用场景：本插件的 ZipVoice 引擎要拉一整套 Python 运行时（约 7.7 GB，含 257 个 `.pyd` 编译模块），
在开启「智能应用控制」（Smart App Control，下称 SAC）的 Windows 11 上，部分模块会被代码完整性策略拒绝，
表现为朗读引擎初始化失败或整段静音。

本文只讲机制和做法，不含本机路径、用户名、证书指纹等本地信息。

## 1. 现象

- 合成报错，文案形如：
  `ImportError: DLL load failed while importing utils: 应用程序控制策略已阻止此文件`
- 插件日志里能看到 `synthesis failed (n/3)`，或整句被跳过（`tts skip`）。
- 直接跑 Python 复现：

  ```
  %LOCALAPPDATA%\dsh-voice-mode\runtimes\<runtime>\Scripts\python.exe -c "from cytoolz import utils; print(utils.__file__)"
  ```

  失败时抛出上面那句 `DLL load failed`。

## 2. 根因

1. 系统开着 SAC：注册表 `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` 下
   `VerifiedAndReputablePolicyState = 1`（开启），Device Guard 的
   `CodeIntegrityPolicyEnforcementStatus = 2`。
2. 生效的策略是微软内置的平台策略，别名 `VerifiedAndReputableDesktop`，ID
   `{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`，平台 ID `{2E07F7E4-194C-4D20-B7C9-6F44A6C5A234}`。
3. 该策略按「签名 + 信誉」判断：未签名、系统不认识的文件直接拒绝。第三方 wheel 里的 `.pyd`
   基本都没签名（本插件这套环境实测 257 个 `.pyd` 中只有 1 个带有效签名），撞上就是随机事件。

对照日志：`Microsoft-Windows-CodeIntegrity/Operational` 事件 ID `3077`，消息里明确写出
被拒文件（`...\.pyd`）和策略 ID，例如：

```
Code Integrity determined that a process (...python.exe) attempted to load
...\cytoolz\utils.cp310-win_amd64.pyd that did not meet the Enterprise signing level
requirements or violated code integrity policy (Policy ID:{0283ac0f-fff1-49ae-ada1-8a933130cad6}).
```

## 3. 为什么不能改那条策略

平台策略是微软签名的内置策略：系统工具 `CiTool.exe --list-policies` 会显示
`平台策略： true`、`策略已签名： true`、`当前强制执行： true`。这类策略不接受用户修改。

但它的策略选项里带着 `Enabled:Allow Supplemental Policies`（允许补充策略），
系统里也已经有微软自己的补充策略挂在同一个基础策略下。所以正确的做法是**挂一层补充策略放行**，
而不是关掉 SAC（关掉之后要重装系统才能再打开）。

## 4. 放行做法（六步，全部本机可完成，需要管理员权限）

1. **造签名证书**（自签即可，SAC 校验的是策略签名而不是文件签名）：

   ```powershell
   $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=<你的策略签名证书>" `
     -CertStoreLocation "Cert:\LocalMachine\My" -KeyExportPolicy Exportable `
     -KeyUsage DigitalSignature `
     -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
   Export-Certificate -Cert $cert -FilePath <策略目录>\signer.cer | Out-Null
   Import-Certificate -FilePath <策略目录>\signer.cer -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
   ```

2. **写补充策略 XML**：`PolicyType="Supplemental Policy"`，`BasePolicyID` 填上面那个平台策略 ID，
   `PlatformID` 填 `{2E07F7E4-...}`，`PolicyID` 用自己生成的新 GUID，
   用一条 `FilePath` 规则按路径放行运行时目录：

   ```xml
   <FileRules>
     <Allow ID="ID_ALLOW_VOICE_RUNTIME" FriendlyName="allow dsh voice runtime"
            FilePath="%LOCALAPPDATA%\dsh-voice-mode\runtimes\*" />
   </FileRules>
   <SigningScenarios>
     <SigningScenario ID="ID_SIGNINGSCENARIO_UMCI" FriendlyName="User mode" Value="12">
       <ProductSigners>
         <FileRulesRef><FileRuleRef RuleID="ID_ALLOW_VOICE_RUNTIME" /></FileRulesRef>
       </ProductSigners>
     </SigningScenario>
   </SigningScenarios>
   ```

   注意 `FilePath` 只能把通配符放在末尾；XML 里必须带 `<Rules />`，且节点顺序按架构来。

3. **补更新签名规则**（不补会被拒：`需要已签名的策略，但未指定 UpdatePolicySigner`）：

   ```powershell
   Add-SignerRule -FilePath <策略目录>\supplemental.xml -CertificatePath <策略目录>\signer.cer -Update
   ```

   只加 `-Update`；`-Supplemental` 只能给基础策略用，加了会报
   `只有基本策略才能具有 SupplementalSigners`。

4. **编译成二进制策略**：

   ```powershell
   ConvertFrom-CIPolicy -XmlFilePath <策略目录>\supplemental.xml -BinaryFilePath <策略目录>\supplemental.cip
   ```

5. **签名并部署**：

   ```powershell
   Set-AuthenticodeSignature -FilePath <策略目录>\supplemental.cip -Certificate $cert -HashAlgorithm SHA256
   CiTool.exe --update-policy <策略目录>\supplemental.cip
   ```

6. **重启系统**。`CiTool.exe --refresh` 不能热加载策略，必须重启（实测重启前策略已列出但规则不生效）。

## 5. 验证（重启后）

1. 策略已登记：`CiTool.exe --list-policies` 能看到那条补充策略（基础策略是平台策略那个 ID）。
2. 被拦文件可直接加载：

   ```
   python.exe -c "from cytoolz import utils; print(utils.__file__)"
   ```

   返回真实的 `site-packages\cytoolz\utils.cp310-win_amd64.pyd`，加载器是 `ExtensionFileLoader`。
3. 重启后不再产生新的事件 `3077`（用系统启动时间对照最后一条拦截时间）。
4. 端到端：直接拉起 TTS worker，能 `READY` 并合成出音频。

实测结论：放行后 cytoolz、triton、scipy.sparse 三个原先被拒的模块全部可导入；
清掉任何纯 Python 替身代码后 worker 仍能就绪并合成。注意 `CiTool` 里这条补充策略可能仍显示
`策略已签名： false`、`当前强制执行： false`，这不代表规则没生效——以「事件 3077 是否再出现」
和「被拒模块能否加载」为准。

## 6. 撤销

```powershell
CiTool.exe --remove-policy {<补充策略的 PolicyID>}
```

删除后重启即回到拦截状态。补充策略里只有「允许」规则，没有拒绝规则，所以写错的最坏结果是
「不生效」，不会挡住其他程序。签名证书可用
`Remove-Item Cert:\LocalMachine\My\<指纹>` 与 `Cert:\LocalMachine\Root\<指纹>` 清理。

## 7. 局限

- 只覆盖用户态（`Value="12"`）。如果以后有内核态模块被拦，需要另加内核场景。
- 按路径放行意味着**运行时目录里的任何文件**都被允许。该目录必须只放本插件自己的运行时，
  不要指向用户可写的大目录。
- 放行不改变 SAC 的其它判断；系统更新若新增更严的策略，仍可能出现新的拦截点，
  排查入口始终是事件 `3077` 加 `CiTool --list-policies`。

## 8. 另一条更省事但不可逆的路

关闭 SAC 也能解决，但关掉之后要重装系统才能再打开，因此本项目不采用，也不建议为了朗读去关它。
