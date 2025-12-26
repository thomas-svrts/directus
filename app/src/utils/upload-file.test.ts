import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PreviousUpload } from 'tus-js-client';

// Mock dependencies BEFORE imports
vi.mock('@/api', () => ({
	default: {
		get: vi.fn(),
		patch: vi.fn(),
		post: vi.fn(),
	},
}));

vi.mock('@/events', () => ({
	emitter: {
		emit: vi.fn(),
	},
	Events: {
		upload: 'upload',
		tusResumableUploadsChanged: 'tusResumableUploadsChanged',
	},
}));

vi.mock('@/lang', () => ({
	i18n: {
		global: {
			t: vi.fn((key) => key),
		},
	},
}));

vi.mock('@/utils/get-root-path', () => ({
	getRootPath: () => 'http://localhost:8055/',
}));

vi.mock('@/utils/notify', () => ({
	notify: vi.fn(),
}));

vi.mock('tus-js-client', () => ({
	Upload: vi.fn(),
}));

vi.mock('@/stores/server', () => ({
	useServerStore: vi.fn(() => ({
		info: {
			uploads: {
				tus: true,
				chunkSize: 5242880, // 5MB
			},
		},
	})),
}));

// Import AFTER mocks
import { Upload } from 'tus-js-client';
import { uploadFile } from './upload-file';

describe('uploadFile TUS localStorage bug fix', () => {
	let mockFile: File;
	let mockUploadInstance: any;
	let capturedOptions: any;

	beforeEach(() => {
		vi.clearAllMocks();

		// Create a mock file
		mockFile = new File(['test content'], 'test.jpg', { type: 'image/jpeg' });

		// Mock the Upload instance
		mockUploadInstance = {
			start: vi.fn(),
			abort: vi.fn(),
			findPreviousUploads: vi.fn(),
			resumeFromPreviousUpload: vi.fn(),
		};

		// Capture the options passed to Upload constructor
		vi.mocked(Upload).mockImplementation((file: any, options: any) => {
			capturedOptions = options;
			return mockUploadInstance as any;
		});
	});

	test('should NOT reuse old file ID from localStorage when resuming', async () => {
		// SCENARIO: User uploaded a file yesterday, file got deleted from server,
		// now user uploads same file again. TUS finds old upload in localStorage.
		const previousUpload: PreviousUpload = {
			uploadUrl: 'http://localhost:8055/files/tus/abc123',
			metadata: {
				id: 'old-deleted-file-id', // <- This file was deleted from server!
				filename_download: 'test.jpg',
				type: 'image/jpeg',
			},
			creationTime: Date.now().toString(),
			size: mockFile.size,
		};

		mockUploadInstance.findPreviousUploads.mockResolvedValue([previousUpload]);

		// Start upload
		uploadFile(mockFile);

		// Wait for TUS to process previous uploads
		await vi.waitFor(() => expect(mockUploadInstance.start).toHaveBeenCalled());

		// VERIFY: TUS resumes from previous uploadUrl (correct - this is how TUS works)
		expect(mockUploadInstance.resumeFromPreviousUpload).toHaveBeenCalledWith(previousUpload);

		// VERIFY: metadata should NOT contain the old deleted file ID
		// The bug was: fileInfo.id = previousUploads[0]!.metadata['id'];
		// This would cause GET /files/guid with old ID -> server 403 error
		expect(capturedOptions.metadata.id).toBeUndefined();

		// Server will provide NEW file ID via onAfterResponse callback
		// That's the correct way according to TUS spec
	});

	test('should allow explicit fileId option to override', async () => {
		// SCENARIO: User wants to replace existing file
		mockUploadInstance.findPreviousUploads.mockResolvedValue([]);

		uploadFile(mockFile, {
			fileId: 'specific-file-123',
		});

		await vi.waitFor(() => expect(mockUploadInstance.start).toHaveBeenCalled());

		// When explicitly provided, fileId should be in metadata
		expect(capturedOptions.metadata.id).toBe('specific-file-123');
	});

	test('should get new file ID from server via onAfterResponse', async () => {
		mockUploadInstance.findPreviousUploads.mockResolvedValue([]);

		uploadFile(mockFile);

		await vi.waitFor(() => expect(Upload).toHaveBeenCalled());

		// Simulate server response with new file ID
		const mockResponse = {
			getHeader: vi.fn().mockReturnValue('new-file-456'),
		};

		// Call the onAfterResponse callback
		capturedOptions.onAfterResponse({}, mockResponse);

		// Verify the header was read
		expect(mockResponse.getHeader).toHaveBeenCalledWith('Directus-File-Id');
	});
});
