import * as path from "path";
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as toml from 'toml';
import { spawnSync } from 'child_process';
import { AssetHashType, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as lambda  from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export interface RagLambdaProps {
  knowledgeBaseId: string;
  appName: string;
  logLevel: string;
  appParamFile: string;
  queryExpansionModelId?: string;
  encryptionKey: kms.IKey;
  /** Bedrock regions allowed for model invocation (defaults to deploy region if not specified) */
  bedrockRegions?: string[];
}

export class RagLambda extends Construct {
  public readonly lambda: lambda.Function;

  constructor(scope: Construct, id: string, props: RagLambdaProps) {
    super(scope, id);

    // デフォルトの推論設定ファイル ディレクトリパス
    const defaultConfigDirPath = path.join(__dirname, "../../../config/defaults");
    // アプリ固有の推論設定ファイル ディレクトリパス
    const appConfigDirPath = path.join(__dirname, "../../../config/apps");

    // 設定ファイルのハッシュを計算
    const configFilesHash = this.calculateConfigFilesHash(defaultConfigDirPath, appConfigDirPath, props.appParamFile);
    console.log(`Config files hash for ${props.appParamFile}: ${configFilesHash}`);

    // Lambda関数のログを暗号化するためのLogGroupを明示的に作成
    const logGroup = new logs.LogGroup(this, 'RagFunctionLogGroup', {
      logGroupName: `/aws/lambda/${props.appName}-RagFunction`,
      encryptionKey: props.encryptionKey,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Lambdaのアセットを構築するためのカスタムハンドラー
    this.lambda = new lambda.Function(this, 'RagFunction', {
      functionName: `${props.appName}-RagFunction`,
      runtime: lambda.Runtime.PYTHON_3_14,
      logGroup: logGroup,
      code: lambda.Code.fromAsset(path.join(__dirname, "invokeModel"), {
        assetHash: configFilesHash, // 設定ファイルのハッシュを使用して強制的な再ビルドをトリガー
        assetHashType: AssetHashType.CUSTOM, // カスタムハッシュを使用
        bundling: {
          // imageとcommandは必須だが、localが成功すれば使われない
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: ['echo', 'Local bundling is used - Docker bundling is skipped'],

          // Local bundling: すべての環境でDockerを使わずにビルド
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const lambdaSourceDir = path.join(__dirname, "invokeModel");

                console.log(`[Local Bundling] Starting bundle process for ${outputDir}`);

                // Step 1: pip install dependencies
                console.log('[Local Bundling] Installing Python dependencies...');
                const pipResult = spawnSync('pip', [
                  'install',
                  '-r', 'requirements.txt',
                  '-t', outputDir
                ], {
                  cwd: lambdaSourceDir,
                  stdio: 'inherit'
                });
                if (pipResult.status !== 0) {
                  throw new Error(`pip install failed with status ${pipResult.status}`);
                }

                // Step 2: Copy source code
                console.log('[Local Bundling] Copying source code...');
                const copySourceResult = spawnSync('cp', [
                  '-a', '.', outputDir
                ], {
                  cwd: lambdaSourceDir,
                  stdio: 'inherit'
                });
                if (copySourceResult.status !== 0) {
                  throw new Error(`Source copy failed with status ${copySourceResult.status}`);
                }

                // Step 3: Create config directories
                console.log('[Local Bundling] Creating config directories...');
                const mkdirResult = spawnSync('mkdir', [
                  '-p',
                  path.join(outputDir, 'config/defaults'),
                  path.join(outputDir, 'config/apps')
                ], {
                  stdio: 'inherit'
                });
                if (mkdirResult.status !== 0) {
                  throw new Error(`mkdir failed with status ${mkdirResult.status}`);
                }

                // Step 4: Copy default config files
                console.log('[Local Bundling] Copying default config files...');
                const copyDefaultsResult = spawnSync('cp', [
                  '-r',
                  `${defaultConfigDirPath}/.`,
                  path.join(outputDir, 'config/defaults/')
                ], {
                  stdio: 'inherit'
                });
                if (copyDefaultsResult.status !== 0) {
                  throw new Error(`Default config copy failed with status ${copyDefaultsResult.status}`);
                }

                // Verification: List copied default configs
                console.log('[Local Bundling] Copied default configs:');
                spawnSync('ls', ['-la', path.join(outputDir, 'config/defaults/')], {
                  stdio: 'inherit'
                });

                // Step 5: Copy app config file
                const appConfigPath = path.join(appConfigDirPath, props.appParamFile);
                if (fs.existsSync(appConfigPath)) {
                  console.log(`[Local Bundling] Copying app config: ${props.appParamFile}`);
                  const copyAppConfigResult = spawnSync('cp', [
                    appConfigPath,
                    path.join(outputDir, 'config/apps/')
                  ], {
                    stdio: 'inherit'
                  });
                  if (copyAppConfigResult.status !== 0) {
                    throw new Error(`App config copy failed with status ${copyAppConfigResult.status}`);
                  }

                  // Verification: List copied app configs
                  console.log('[Local Bundling] Copied app configs:');
                  spawnSync('ls', ['-la', path.join(outputDir, 'config/apps/')], {
                    stdio: 'inherit'
                  });
                } else {
                  console.warn(`[Local Bundling] App config file not found: ${appConfigPath}`);
                }

                // Step 6: Create dummy file (for consistency with Docker bundling)
                const dummyPath = path.join(outputDir, 'dummy.txt');
                fs.writeFileSync(dummyPath, '');

                console.log('[Local Bundling] Bundle completed successfully');
                return true; // Success

              } catch (error) {
                console.error('[Local Bundling] Bundle failed:', error);
                return false; // Failure
              }
            }
          }
        },
      }),
      handler: 'app.handler',
      description: 'RAG Lambda function with query expansion and KB retrieval',
      memorySize: 512,
      timeout: Duration.seconds(900),
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        KB_NUM_RESULTS: '20',
        APP_NAME: props.appName,
        LOG_LEVEL: props.logLevel,
        CONFIG_FILES_HASH: configFilesHash,
        APP_PARAM_FILE: props.appParamFile,
        AWS_ACCOUNT_ID: Stack.of(this).account,
      }
    });

    // 使用可能なすべてのモデルIDを取得
    const modelIds = this.getAllModelIds(defaultConfigDirPath, path.join(appConfigDirPath, props.appParamFile));

    // クエリ拡張用のモデルIDも追加
    if (props.queryExpansionModelId) {
      modelIds.push(props.queryExpansionModelId);
    } else {
      modelIds.push('anthropic.claude-3-haiku-20240307-v1:0');
    }

    // デフォルトのモデルIDをセット(設定からモデルが見つからない場合はAmazon Nova Liteを使用)
    if (modelIds.length === 0) {
      modelIds.push("amazon.nova-lite-v1:0");
    }

    // 重複を除去
    const uniqueModelIds = Array.from(new Set(modelIds));

    // モデルIDごとにARNを生成
    // 推論プロファイル形式 (例: jp.anthropic.claude-sonnet-4-5-20250929-v1:0) と
    // foundation-model形式 (例: anthropic.claude-3-haiku-20240307-v1:0) を判定して適切なARNを生成
    // bedrockRegions が指定されていない場合はデプロイリージョンのみを対象とする
    const bedrockRegions = props.bedrockRegions ?? [Stack.of(this).region];

    const modelArns = uniqueModelIds.flatMap(modelId => {
      // 推論プロファイル形式かどうかを判定
      // 推論プロファイルは通常、リージョンコード(us, eu, jp, apac等)で始まる
      const inferenceProfilePattern = /^(us|eu|jp|apac|global)\./;

      return bedrockRegions.flatMap(region => {
        const arns: string[] = [];

        if (inferenceProfilePattern.test(modelId)) {
          // 推論プロファイル形式の場合
          // 1. 推論プロファイルそのもののARN（接頭辞付き）
          arns.push(`arn:aws:bedrock:${region}:${Stack.of(this).account}:inference-profile/${modelId}`);

          // 2. ベースモデルのARN（接頭辞を除去）
          // 例: jp.anthropic.claude-sonnet-4-5-20250929-v1:0 → anthropic.claude-sonnet-4-5-20250929-v1:0
          const baseModelId = modelId.replace(inferenceProfilePattern, '');
          arns.push(`arn:aws:bedrock:${region}::foundation-model/${baseModelId}`);

          console.log(`Inference profile detected: ${modelId} (base model: ${baseModelId})`);
        } else {
          // foundation-model形式の場合
          arns.push(`arn:aws:bedrock:${region}::foundation-model/${modelId}`);
          console.log(`Foundation model detected: ${modelId}`);
        }

        return arns;
      });
    });

    console.log(`Generated ${modelArns.length} model ARNs for IAM policy`);

    // モデル呼び出し権限を付与
    this.lambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile"
      ],
      resources: modelArns,
    }));

    // Knowledge Base の呼び出し権限を付与
    this.lambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock:Retrieve",
        "bedrock:RetrieveAndGenerate",
      ],
      resources: [`arn:aws:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:knowledge-base/${props.knowledgeBaseId}`],
    }));

    // AWS Marketplace Policy for Converse API functions
    this.lambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'aws-marketplace:Subscribe',
        'aws-marketplace:Unsubscribe',
        'aws-marketplace:ViewSubscriptions',
      ],
      resources: ['*'],
    }));

    // CDK NAG サプレッション
    NagSuppressions.addResourceSuppressions(
      this.lambda.role!,[
        {
          id: 'AwsSolutions-IAM4',
          reason: 'The rule prohibiting the Managed role suppressed',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'X-ray put permissions do not support resource level access control',
        }
      ]
    );

    // DefaultPolicy に対する CDK NAG サプレッション
    const defaultPolicy = this.lambda.role!.node.tryFindChild('DefaultPolicy');
    if (defaultPolicy) {
      NagSuppressions.addResourceSuppressions(
        defaultPolicy,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'AWS Marketplace permissions do not support resource level access control',
            appliesTo: ['Resource::*']
          }
        ]
      );
    }
  }

  /**
   * 設定ファイルからすべてのmodelIdを収集する
   */
  private getAllModelIds(defaultConfigDirPath: string, appConfigFilePath: string): string[] {
    const modelIds = new Set<string>();

    // オブジェクト内のすべてのmodelIdを再帰的に検索して収集する関数
    const extractModelIds = (obj: any, collector: Set<string>): void => {
      if (!obj || typeof obj !== 'object') {
        return;
      }

      // オブジェクトのすべてのプロパティを走査
      for (const key in obj) {
        // modelIdプロパティを発見した場合
        if (key === 'modelId' && typeof obj[key] === 'string') {
          collector.add(obj[key]);
        }
        // ネストされたオブジェクトを再帰的に処理
        else if (typeof obj[key] === 'object') {
          extractModelIds(obj[key], collector);
        }
      }
    };

    // TOMLファイルを処理する関数
    const processTomlFile = (filePath: string, collector: Set<string>): void => {
      try {
        // ファイルの存在確認
        if (!fs.existsSync(filePath)) {
          console.warn(`File not found: ${filePath}`);
          return;
        }

        // ファイルであることを確認
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          console.warn(`Path is not a file: ${filePath}`);
          return;
        }

        // ファイル読み込みと解析
        const content = fs.readFileSync(filePath, 'utf8');
        const config = toml.parse(content);

        // modelIdを抽出
        extractModelIds(config, collector);
      } catch (error) {
        console.warn(`Error processing TOML file ${filePath}:`, error);
      }
    };

    // ディレクトリ内のすべてのTOMLファイルを処理する関数
    const processTomlFilesInDirectory = (dirPath: string, collector: Set<string>): void => {
      try {
        // ディレクトリの存在確認
        if (!fs.existsSync(dirPath)) {
          console.warn(`Directory not found: ${dirPath}`);
          return;
        }

        // ディレクトリであることを確認
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory()) {
          console.warn(`Path is not a directory: ${dirPath}`);
          return;
        }

        // ディレクトリ内のすべてのファイルを取得
        const files = fs.readdirSync(dirPath);

        // .tomlファイルだけを処理
        for (const file of files) {
          if (file.endsWith('.toml')) {
            processTomlFile(path.join(dirPath, file), collector);
          }
        }
      } catch (error) {
        console.warn(`Error reading directory ${dirPath}:`, error);
      }
    };

    // デフォルト設定ディレクトリの処理
    processTomlFilesInDirectory(defaultConfigDirPath, modelIds);

    // アプリ固有設定ファイルの処理
    processTomlFile(appConfigFilePath, modelIds);

    return Array.from(modelIds);
  }

  /**
   * 推論設定ファイルとLambdaソースコードのハッシュを計算する
   */
  private calculateConfigFilesHash(defaultConfigDirPath: string, appConfigDirPath: string, appParamFile: string): string {
    let combinedHash = '';

    // デフォルト設定ディレクトリからすべての.tomlファイルを読み込みハッシュを計算
    if (fs.existsSync(defaultConfigDirPath)) {
      const files = fs.readdirSync(defaultConfigDirPath).filter(file => file.endsWith('.toml')).sort();
      for (const file of files) {
        const filePath = path.join(defaultConfigDirPath, file);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, 'utf8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          combinedHash += `${file}:${hash};`;
        }
      }
    }

    // アプリケーション固有の設定ファイルが存在すればハッシュを計算
    const appConfigPath = path.join(appConfigDirPath, appParamFile);
    if (fs.existsSync(appConfigPath) && fs.statSync(appConfigPath).isFile()) {
      const content = fs.readFileSync(appConfigPath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      combinedHash += `${appParamFile}:${hash};`;
    }

    // Lambda関数のソースコード(.py, .json, requirements.txt)もハッシュ計算に含める
    // ただし、tests/ディレクトリは除外する
    const lambdaSourceDir = path.join(__dirname, "invokeModel");

    // 再帰的にファイルを取得する関数
    const getAllSourceFiles = (dir: string, baseDir: string = dir): string[] => {
      const files: string[] = [];

      if (!fs.existsSync(dir)) {
        return files;
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // tests, __pycache__, .gitディレクトリは除外
          if (entry.name === 'tests' || entry.name === '__pycache__' || entry.name.startsWith('.')) {
            continue;
          }
          // サブディレクトリを再帰的に処理
          files.push(...getAllSourceFiles(fullPath, baseDir));
        } else if (entry.isFile()) {
          // .py, .json, requirements.txt のみを対象とする
          if (entry.name.endsWith('.py') ||
              entry.name.endsWith('.json') ||
              entry.name === 'requirements.txt') {
            // ベースディレクトリからの相対パスを使用
            files.push(path.relative(baseDir, fullPath));
          }
        }
      }
      return files;
    };

    if (fs.existsSync(lambdaSourceDir)) {
      const sourceFiles = getAllSourceFiles(lambdaSourceDir).sort();

      for (const relativeFile of sourceFiles) {
        const filePath = path.join(lambdaSourceDir, relativeFile);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, 'utf8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          combinedHash += `${relativeFile}:${hash};`;
        }
      }
    }

    // 全体のハッシュを計算
    return crypto.createHash('sha256').update(combinedHash).digest('hex');
  }
}
