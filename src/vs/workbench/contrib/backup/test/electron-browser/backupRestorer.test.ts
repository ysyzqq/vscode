/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as platform from 'vs/base/common/platform';
import * as os from 'os';
import * as path from 'vs/base/common/path';
import * as pfs from 'vs/base/node/pfs';
import { URI } from 'vs/base/common/uri';
import { createTextBufferFactory } from 'vs/editor/common/model/textModel';
import { getRandomTestPath } from 'vs/base/test/node/testUtils';
import { DefaultEndOfLine } from 'vs/editor/common/model';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { hashPath } from 'vs/workbench/services/backup/node/backupFileService';
import { BackupTracker } from 'vs/workbench/contrib/backup/common/backupTracker';
import { TestTextFileService, workbenchInstantiationService } from 'vs/workbench/test/workbenchTestServices';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { TextFileEditorModelManager } from 'vs/workbench/services/textfile/common/textFileEditorModelManager';
import { BackupRestorer } from 'vs/workbench/contrib/backup/common/backupRestorer';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { EditorPart } from 'vs/workbench/browser/parts/editor/editorPart';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { EditorService } from 'vs/workbench/services/editor/browser/editorService';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorInput } from 'vs/workbench/common/editor';
import { FileEditorInput } from 'vs/workbench/contrib/files/common/editors/fileEditorInput';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { IEditorRegistry, EditorDescriptor, Extensions as EditorExtensions } from 'vs/workbench/browser/editor';
import { TextFileEditor } from 'vs/workbench/contrib/files/browser/editors/textFileEditor';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { NodeTestBackupFileService } from 'vs/workbench/services/backup/test/electron-browser/backupFileService.test';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { isEqual } from 'vs/base/common/resources';

const userdataDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'backuprestorer');
const backupHome = path.join(userdataDir, 'Backups');
const workspacesJsonPath = path.join(backupHome, 'workspaces.json');

const workspaceResource = URI.file(platform.isWindows ? 'c:\\workspace' : '/workspace');
const workspaceBackupPath = path.join(backupHome, hashPath(workspaceResource));
const fooFile = URI.file(platform.isWindows ? 'c:\\Foo' : '/Foo');
const barFile = URI.file(platform.isWindows ? 'c:\\Bar' : '/Bar');
const untitledFile1 = URI.from({ scheme: Schemas.untitled, path: 'Untitled-1' });
const untitledFile2 = URI.from({ scheme: Schemas.untitled, path: 'Untitled-2' });

class TestBackupRestorer extends BackupRestorer {
	async doRestoreBackups(): Promise<URI[] | undefined> {
		return super.doRestoreBackups();
	}
}

class ServiceAccessor {
	constructor(
		@ITextFileService public textFileService: TestTextFileService,
		@IUntitledTextEditorService public untitledTextEditorService: IUntitledTextEditorService
	) {
	}
}

suite('BackupRestorer', () => {
	let accessor: ServiceAccessor;

	let disposables: IDisposable[] = [];

	setup(async () => {
		disposables.push(Registry.as<IEditorRegistry>(EditorExtensions.Editors).registerEditor(
			EditorDescriptor.create(
				TextFileEditor,
				TextFileEditor.ID,
				'Text File Editor'
			),
			[new SyncDescriptor<EditorInput>(FileEditorInput)]
		));

		// Delete any existing backups completely and then re-create it.
		await pfs.rimraf(backupHome, pfs.RimRafMode.MOVE);
		await pfs.mkdirp(backupHome);

		return pfs.writeFile(workspacesJsonPath, '');
	});

	teardown(async () => {
		dispose(disposables);
		disposables = [];

		(<TextFileEditorModelManager>accessor.textFileService.models).clear();
		(<TextFileEditorModelManager>accessor.textFileService.models).dispose();
		accessor.untitledTextEditorService.revertAll();

		return pfs.rimraf(backupHome, pfs.RimRafMode.MOVE);
	});

	test('Restore backups', async function () {
		this.timeout(20000);

		const backupFileService = new NodeTestBackupFileService(workspaceBackupPath);
		const instantiationService = workbenchInstantiationService();
		instantiationService.stub(IBackupFileService, backupFileService);

		const part = instantiationService.createInstance(EditorPart);
		part.create(document.createElement('div'));
		part.layout(400, 300);

		instantiationService.stub(IEditorGroupsService, part);

		const editorService: EditorService = instantiationService.createInstance(EditorService);
		instantiationService.stub(IEditorService, editorService);

		accessor = instantiationService.createInstance(ServiceAccessor);

		await part.whenRestored;

		const tracker = instantiationService.createInstance(BackupTracker);
		const restorer = instantiationService.createInstance(TestBackupRestorer);

		// Backup 2 normal files and 2 untitled file
		await backupFileService.backupResource(untitledFile1, createTextBufferFactory('untitled-1').create(DefaultEndOfLine.LF).createSnapshot(false));
		await backupFileService.backupResource(untitledFile2, createTextBufferFactory('untitled-2').create(DefaultEndOfLine.LF).createSnapshot(false));
		await backupFileService.backupResource(fooFile, createTextBufferFactory('fooFile').create(DefaultEndOfLine.LF).createSnapshot(false));
		await backupFileService.backupResource(barFile, createTextBufferFactory('barFile').create(DefaultEndOfLine.LF).createSnapshot(false));

		// Verify backups restored and opened as dirty
		await restorer.doRestoreBackups();
		assert.equal(editorService.count, 4);
		assert.ok(editorService.editors.every(editor => editor.isDirty()));

		let counter = 0;
		for (const editor of editorService.editors) {
			const resource = editor.getResource();
			if (isEqual(resource, untitledFile1)) {
				const model = await accessor.untitledTextEditorService.createOrGet(resource).resolve();
				assert.equal(model.textEditorModel.getValue(), 'untitled-1');
				counter++;
			} else if (isEqual(resource, untitledFile2)) {
				const model = await accessor.untitledTextEditorService.createOrGet(resource).resolve();
				assert.equal(model.textEditorModel.getValue(), 'untitled-2');
				counter++;
			} else if (isEqual(resource, fooFile)) {
				const model = await accessor.textFileService.models.get(resource!)?.load();
				assert.equal(model?.textEditorModel?.getValue(), 'fooFile');
				counter++;
			} else {
				const model = await accessor.textFileService.models.get(resource!)?.load();
				assert.equal(model?.textEditorModel?.getValue(), 'barFile');
				counter++;
			}
		}

		assert.equal(counter, 4);

		part.dispose();
		tracker.dispose();
	});
});
