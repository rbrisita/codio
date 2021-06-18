import * as vscode from 'vscode';
import { zip, unzip } from 'cross-zip';
import { mkdir, readFile, unlink, readdir, exists, writeFile, uriSeperator, isWindows, promiseExec } from '../utils';
import { saveProjectFiles, reduceToRoot } from './saveProjectFiles';
import * as os from 'os';
import * as fs from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { getWorkspaceRootAndCodiosFolder } from './workspace';

const homedir = os.homedir();
const userOS = os.platform();
const onCodiosChangedSubscribers = [];
const EXTENSION_FOLDER = userOS === 'darwin' ? join(homedir, 'Library', 'codio') : join(homedir, 'codio');
const codiosFolder = join(EXTENSION_FOLDER, 'codios');

const CODIO_META_FILE = 'meta.json';
const CODIO_CONTENT_FILE = 'codio.json';
const CODIO_WORKSPACE_FOLDER = 'workspace';

export default class FSManager {
  tempFolder: string;

  onCodiosChanged(func: () => unknown): void {
    onCodiosChangedSubscribers.push(func);
  }

  codioPath(codioId: string): string {
    return join(codiosFolder, codioId);
  }

  constructor() {
    this.tempFolder = os.tmpdir();
  }

  static async saveFile(path: number | fs.PathLike, content: unknown): Promise<void> {
    try {
      await writeFile(path, content);
      console.log('The file was saved!', path);
    } catch (e) {
      console.log('save file fail', e);
    }
  }

  static timelinePath(codioPath: string): string {
    return join(codioPath, 'codio.json');
  }

  static audioPath(codioPath: string): string {
    return join(codioPath, 'audio.mp3');
  }

  /**
   * Return the path to the subtitles file.
   * @param codioPath Path to unzipped codio.
   */
  static subtitlesPath(codioPath: string): string {
    return join(codioPath, 'subtitles.srt');
  }

  static workspacePath(codioPath: string): string {
    return join(codioPath, 'workspace');
  }

  static async loadTimeline(codioPath: string): Promise<Timeline> {
    const timelineContent = await readFile(this.timelinePath(codioPath));
    const parsedTimeline = JSON.parse(timelineContent.toString());
    return parsedTimeline;
  }

  static toRelativePath(uri: vscode.Uri, rootPath: string): string {
    const pathSplit = uri.path.split(uriSeperator);
    const rootPathSplit = rootPath.split(uriSeperator);
    const relativePath = pathSplit.slice(rootPathSplit.length).join(uriSeperator);
    return relativePath;
  }

  static async saveRecordingToFile(
    codioContent: Record<string, unknown>,
    metaData: Record<string, unknown>,
    files: Array<string>,
    codioPath: string,
    destinationFolder?: vscode.Uri,
  ): Promise<void> {
    const codioContentJson = JSON.stringify(codioContent);
    const metaDataJson = JSON.stringify(metaData);
    await this.saveFile(join(codioPath, CODIO_CONTENT_FILE), codioContentJson);
    await this.saveFile(join(codioPath, CODIO_META_FILE), metaDataJson);
    const codioWorkspaceFolderPath = join(codioPath, CODIO_WORKSPACE_FOLDER);
    await saveProjectFiles(codioWorkspaceFolderPath, files);
    if (destinationFolder) {
      await this.zip(codioPath, destinationFolder.fsPath);
    } else {
      fs.renameSync(codioPath, join(codiosFolder, uuid()));
    }
    this.update();
  }

  /**
   * Alert subscribers that the configuration has changed.
   */
  static update(): void {
    onCodiosChangedSubscribers.forEach((func) => func());
  }

  static normalizeFilesPath(fullPathFiles: Array<string>, root?: vscode.Uri): { rootPath: string; files: string[] } {
    // In Windows, case doesn't matter in file names, and some events return files with different cases.
    // That is not the same in Linux for example, where case does matter. The reduceToRoot algorithm is case sensetive,
    // which is why we are normalizing for windows here
    const filesWithNormalizedCase = fullPathFiles.map((file) => (isWindows ? file.toLowerCase() : file));
    if (root) {
      const normalizedFiles = filesWithNormalizedCase.map((path) =>
        this.toRelativePath(vscode.Uri.file(path), root.path),
      );
      return { rootPath: root.path, files: normalizedFiles };
    } else if (filesWithNormalizedCase.length > 1) {
      console.log({ uriSeperator });
      const splitFiles = filesWithNormalizedCase.map((file) => file.split(uriSeperator).slice(1));
      const { rootPath, files } = reduceToRoot(splitFiles);
      return { rootPath, files };
    } else {
      const fullPathSplit = filesWithNormalizedCase[0].split(uriSeperator);
      const rootPath = fullPathSplit.slice(0, -1).join(uriSeperator);
      const file = fullPathSplit[fullPathSplit.length - 1];
      return { rootPath: rootPath, files: [file] };
    }
  }

  static toFullPath(codioPath: string, filePath: string): string {
    return join(codioPath, filePath);
  }

  async folderNameExists(folderName: string): Promise<boolean> {
    return await exists(join(EXTENSION_FOLDER, folderName));
  }

  async createExtensionFolders(): Promise<void> {
    try {
      const extensionFolderExists = await exists(EXTENSION_FOLDER);
      if (!extensionFolderExists) {
        await mkdir(EXTENSION_FOLDER);
      }
      const codiosFolderExists = await exists(codiosFolder);
      if (!codiosFolderExists) {
        await mkdir(codiosFolder);
      }
    } catch (e) {
      console.log('Problem creating your extension folders', e);
    }
  }

  async createCodioFolder(folderName: string): Promise<string> {
    try {
      const path = join(codiosFolder, folderName);
      await mkdir(path);
      return path;
    } catch (e) {
      console.log('Problem creating folder', e);
    }
  }

  async createTempCodioFolder(codioId: string): Promise<string> {
    try {
      const path = join(this.tempFolder, codioId);
      await mkdir(path);
      return path;
    } catch (e) {
      console.log('Problem creating folder', e);
    }
  }

  getCodioUnzipped(uri: vscode.Uri): string | Promise<string> {
    if (fs.lstatSync(uri.fsPath).isDirectory()) {
      return uri.fsPath;
    } else {
      return this.unzipCodio(uri.fsPath);
    }
  }

  static async zip(srcPath: string, distPath: string): Promise<string> {
    try {
      if (isWindows) {
        await new Promise((res, rej) => zip(srcPath, distPath, (error: Error) => (error ? rej(error) : res(''))));
      } else {
        await promiseExec(`cd ${srcPath} && zip -r ${distPath} .`);
      }
      return `${distPath}`;
    } catch (e) {
      console.log(`zip for folder ${srcPath} failed`, e);
    }
  }

  async unzipCodio(srcPath: string): Promise<string> {
    const codioTempFolder = join(this.tempFolder, uuid());
    try {
      // await promiseExec(`unzip ${srcPath} -d ${codioTempFolder}`);
      await new Promise((res, rej) =>
        unzip(srcPath, codioTempFolder, (error: Error) => (error ? rej(error) : res(''))),
      );
      return codioTempFolder;
    } catch (e) {
      console.log(`unzipping codio with path: ${srcPath} failed`, e);
    }
  }

  async deleteFilesInCodio(codioId: string): Promise<string> {
    const path = join(codiosFolder, codioId);
    const files = await readdir(path);
    // currently I am assuming there won't be directories inside the directory
    await Promise.all(files.map((f) => unlink(join(path, f))));
    return path;
  }

  async getCodiosUnzippedFromCodioFolder(folder: fs.PathLike): Promise<unknown[]> {
    const folderContents = await readdir(folder);
    return await Promise.all(
      folderContents
        .map((file) => {
          const fullPath = join(folder.toString(), file);
          if (fs.statSync(fullPath).isDirectory()) {
            return fullPath;
          } else if (file.endsWith('.codio')) {
            return this.getCodioUnzipped(vscode.Uri.file(fullPath));
          }
        })
        .filter((folder) => !!folder),
    );
  }

  /**
   * Get codios found in given folder.
   * @param folder Folder containing codios to get.
   * @param workspaceRoot Optional URI for the root of the workspace.
   * @returns An array of codios found.
   */
  private async getCodios(folder = codiosFolder, workspaceRoot?: vscode.Uri): Promise<Codio[]> {
    const codios: Codio[] = [];

    try {
      const directories = await this.getCodiosUnzippedFromCodioFolder(folder);
      await Promise.all(
        directories.map(async (dir: string) => {
          codios.push({
            ...(await this.getMetaData(dir)),
            uri: vscode.Uri.file(dir),
            workspaceRoot,
          });
        }),
      );

      // Order codios by name.
      codios.sort((a: Metadata, b: Metadata) => {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();

        if (nameA < nameB) {
          return -1;
        } else if (nameA > nameB) {
          return 1;
        }

        return 0;
      });
    } catch (e) {
      console.log(`getCodios failed`, e);
    }

    return codios;
  }

  /**
   * Get workspace and library codio array.
   * @returns Array containing workspace and library codios.
   */
  async getAllCodiosMetadata(): Promise<Codio[]> {
    return [...(await this.getWorkspaceCodios()), ...(await this.getLibraryCodios())];
  }

  /**
   * Get workspace codio array.
   * @returns Array containing workspace codios.
   */
  async getWorkspaceCodios(): Promise<Codio[]> {
    const workspaceFolders = getWorkspaceRootAndCodiosFolder();
    return workspaceFolders
      ? await this.getCodios(workspaceFolders.workspaceCodiosFolder, workspaceFolders.workspaceRootUri)
      : [];
  }

  /**
   * Get library codio array.
   * @returns Array containing library codios.
   */
  async getLibraryCodios(): Promise<Codio[]> {
    return await this.getCodios();
  }

  /**
   * Get metadata file data.
   * @param codioFolderPath Path to codio zip file containing metadata file.
   * @returns Metadata object.
   */
  private async getMetaData(codioFolderPath): Promise<Metadata> {
    try {
      const metaData = await readFile(join(codioFolderPath, CODIO_META_FILE));
      return JSON.parse(metaData.toString());
    } catch (e) {
      console.log(`Problem getting codio ${codioFolderPath} meta data`, e);
    }
  }

  async choose(codiosMetadata: Array<Codio>): Promise<{ path: string; workspaceRoot: vscode.Uri } | undefined> {
    let unlock;
    let itemSelected;
    const quickPickItems = codiosMetadata.map((item) => ({
      label: item.name,
      details: { path: item.uri.fsPath, workspaceRoot: item.workspaceRoot },
    }));
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = quickPickItems;
    quickPick.onDidChangeSelection((e) => {
      itemSelected = e[0];
      unlock();
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      unlock();
    });
    quickPick.show();
    await new Promise((res) => (unlock = res));
    console.log('itemSelected', itemSelected);
    if (itemSelected) {
      return itemSelected.details; // details is the codio path. This due to vscode api being weird here, refactor needed...
    } else {
      return undefined;
    }
  }

  async chooseCodio(): Promise<{ path: string; workspaceRoot?: vscode.Uri } | undefined> {
    return this.choose(await this.getAllCodiosMetadata());
  }
}
