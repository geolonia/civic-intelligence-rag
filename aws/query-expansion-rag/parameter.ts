import type * as cdk from 'aws-cdk-lib';
import { type StackInput, stackInputSchema } from './lib/stack-input';
import { parse as parseToml } from 'toml';
import * as path from 'path';
import { readFileSync } from 'fs';
import { preprocessContextValues } from './lib/utils/cdk-context-parser';

// CDK Context からパラメータを取得する場合
const getContext = (app: cdk.App): StackInput => {
  const rawContext = app.node.getAllContext();
  const preprocessed = preprocessContextValues(rawContext);
  const params = stackInputSchema.parse(preprocessed);
  return params;
};

// デプロイ先ごとに異なるパラメータを定義する必要がある場合は以下のセクションを編集する
const deploy_envs: Record<string, Partial<StackInput>> = {
  "-dev": {
    // "qeRagAppNames": [
    //   {"appName": "qerag", "appParamFile": "qerag.toml"}
    // ],

    "qeRagAppNamesWithSharedCmek": [
      {"appName": "qerag-shared-1", "appParamFile": "qerag.toml"}
    ],
    // 許可する送信元 IPv4 アドレス範囲を指定してください
    allowedIpV4AddressRanges: [
      "0.0.0.0/0", // TODO: Replace with your actual source IP address ranges
    ],

    // SSO スイッチロールを使用する場合はロール名を指定してください（不要な場合は削除可）
    // switchRoleName: "AWSReservedSSO_SwitchOnlyRole_xxxxxxxxxxxx",

    // Bedrock モデルを呼び出し可能なリージョン一覧（省略時はデプロイリージョンのみ）
    // bedrockRegions: ["ap-northeast-1", "ap-northeast-3"],

    // ログレベル（開発環境ではDEBUGログを出力）
    logLevel: "DEBUG",
  },
  // "-stg": {
  //   // ステージング環境にデプロイするRAG API定義
  //   "qeRagAppNamesWithSharedCmek": [
  //     {"appName": "qerag-shared-1", "appParamFile": "qerag.toml"}
  //   ],

  //   // ログレベル（ステージング環境ではINFOログを出力）
  //   logLevel: "INFO",
  // },
  // "-prd": {
  //   // 本番環境にデプロイするRAG API定義
  //   "qeRagAppNamesWithSharedCmek": [
  //     {"appName": "qerag-shared-1", "appParamFile": "qerag.toml"}
  //   ],
    
  //   // ログレベル（本番環境ではINFOログを出力）
  //   logLevel: "INFO",
  // },
};

// CDK Context > parameter.ts の順でパラメータを取得する
export const getParams = (app: cdk.App): StackInput => {
  // デフォルトでは CDK Context からパラメータを取得する
  const params = getContext(app);

  // env が deploy_envs で定義したものにマッチした場合は、
  // deploy_envs のパラメータを context よりも優先して使用する
  const mergedEnv = {
    ...params,
    ...deploy_envs[params.env]
  }

  // zodでparameterのvalidationを実施
  const parsed_params = stackInputSchema.parse(mergedEnv)

  return parsed_params;
};

// Common Validator
interface MergedParams {
  appName: string;
  idcUserNames: string[];
  appParamFile: string;
}
type PartialMergedParams = Partial<MergedParams>;


export function readTomlFile(path: string): PartialMergedParams {
  if (!path.endsWith('.toml')) throw new Error(`Unsupported file: ${path}`);
  const content = readFileSync(path, 'utf-8');
  return parseToml(content) as PartialMergedParams;
}

export function mergeAppParams(
  params: StackInput,
  AppConfig: PartialMergedParams
): MergedParams {
  let result: PartialMergedParams = { ...AppConfig };

  // config/appsにアプリ個別のパラメータ用tomlファイルが定義されていればパスを取得
  const rawPath: string = AppConfig.appParamFile ?? ''
  const tomlPath =
    typeof rawPath === 'string' && rawPath.endsWith('.toml')
      ? rawPath
      : undefined;

  // tomlファイルの内容を取得してApiConfigにマージ
  if (tomlPath) {
    const appParams = readTomlFile(path.join(__dirname, "./config/apps/", tomlPath));
    result = { ...result, ...appParams };
  }

  // アプリ個別のパラメーターにidcUserNamesが存在しない場合はcdk.jsonから取得する
  if (!('idcUserNames' in result)) {
    result.idcUserNames = params.idcUserNames ?? [];
  }

  return result as MergedParams;
}

/**
 * qeRagAppNamesとqeRagAppNamesWithSharedCmekの間でアプリ名の重複をチェックする。
 * 重複が検出された場合はエラーをthrowする。
 *
 * @param params - 検証対象のStackInput
 * @throws Error - 重複したアプリ名が検出された場合
 */
export function validateAppNames(params: StackInput): void {
  const qeAppNames = new Set(params.qeRagAppNames.map((app) => app.appName));
  const sharedAppNames = new Set(
    params.qeRagAppNamesWithSharedCmek.map((app) => app.appName)
  );

  const duplicates = [...qeAppNames].filter((name) => sharedAppNames.has(name));

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate app names detected between qeRagAppNames and qeRagAppNamesWithSharedCmek: ${duplicates.join(', ')}. ` +
        `Each app name must be unique across both configurations to avoid resource conflicts.`
    );
  }
}

